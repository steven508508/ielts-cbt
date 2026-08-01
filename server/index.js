'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', Number(config.trustProxy) || config.trustProxy);
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

// 基本安全標頭（不引入額外套件，維持零相依）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  if (config.isProduction && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// 靜態資源
app.use(express.static(config.PUBLIC_DIR, { extensions: ['html'] }));
app.use('/uploads', express.static(config.UPLOAD_DIR, {
  maxAge: '7d',
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

// API
// wrapRouter：Express 4 接不住 async handler 的 rejection，沒包的話
// 一旦出錯請求會整個卡住（沒有回應也沒有日誌）。包過之後一律回 500。
const { wrapRouter } = require('./middleware/asyncRoutes');
const api = (p, mod) => app.use(p, wrapRouter(require(mod)));

api('/api/auth', './routes/auth');
api('/api/users', './routes/users');
api('/api/tests', './routes/tests');
api('/api/import', './routes/importer');
api('/api/media', './routes/media');
api('/api/exam', './routes/exam');
api('/api/speaking', './routes/speaking');
api('/api/results', './routes/results');
api('/api/ai', './routes/ai');
api('/api/manage', './routes/manage');
api('/api/practice', './routes/practice');
api('/api/notifications', './routes/notifications');

app.get('/api/health', async (req, res) => {
  // 健康檢查自己不能被資料庫拖住。連線池滿的時候查詢會排隊，
  // 沒有這個逾時的話健康檢查也會一起卡死，外面就永遠看不出有問題。
  const probe = db.query('SELECT 1').then(() => null, (e) => e);
  const timeout = new Promise((r) => setTimeout(() => r(new Error('資料庫在 3 秒內沒有回應（連線池可能已滿）')), 3000));
  const err = await Promise.race([probe, timeout]);
  if (err) return res.status(503).json({ ok: false, error: err.message });
  res.json({
    ok: true, time: Date.now(),
    version: require('../package.json').version,
    uptime: Math.round(process.uptime()),
  });
});

// SPA 後備路由
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(config.PUBLIC_DIR, 'index.html'));
});

// 錯誤處理
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  res.status(status).json({ error: err.message || '伺服器發生錯誤' });
});

async function start() {
  for (const d of ['audio', 'image', 'speaking']) {
    fs.mkdirSync(path.join(config.UPLOAD_DIR, d), { recursive: true });
  }
  try {
    await db.initSchema();
    const created = await db.bootstrapAdmin();
    if (created) {
      console.log('────────────────────────────────────────────');
      console.log(` 已建立管理員帳號：${created}`);
      console.log(` 預設密碼：${config.bootstrapAdmin.password}`);
      console.log(' 登入後請立刻到「我的帳號」修改密碼。');
      console.log('────────────────────────────────────────────');
    }
  } catch (e) {
    console.error('\n無法連線到 MySQL：', e.message);
    console.error('請確認 .env 裡的 DB_HOST / DB_USER / DB_PASSWORD / DB_NAME 設定正確，且 MySQL 已啟動。\n');
    process.exit(1);
  }

  if (config.isProduction && config.jwtSecret === 'dev-insecure-secret-change-me') {
    console.warn('\n⚠  JWT_SECRET 還是預設值！任何人都能偽造登入。');
    console.warn('   請設定環境變數 JWT_SECRET（例如 openssl rand -hex 32）\n');
  }

  const http = require('http');
  const server = http.createServer(app);

  // 口說即時語音對話（WebSocket）
  const realtime = require('./lib/realtime');
  const wss = realtime.attach(server);

  // 自動清理逾期資料
  const retention = require('./lib/retention');
  retention.schedule();

  // 上次關機時還在跑的 AI 背景工作其實早就沒了，標記成中斷免得永遠轉圈
  await require('./lib/jobs').reapStale();

  // 卡住的批改要撿回來，否則學生的成績頁會永遠轉圈
  require('./lib/grade').scheduleSweep();

  server.listen(config.port, config.host, () => {
    console.log(`IELTS 模擬考系統已啟動 → http://localhost:${config.port}`);
    console.log(`口說即時語音通道 → ws://localhost:${config.port}/ws/speaking`);
  });

  // 優雅關機：讓進行中的請求跑完再退出（Docker stop / systemd restart 會用到）
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在關閉…`);
    const force = setTimeout(() => { console.log('逾時，強制結束'); process.exit(1); }, 15000);
    // server.close() 只會停止接受新連線，已建立的 WebSocket 會一直開著，
    // 不主動收掉的話 callback 永遠不會被呼叫，每次重新部署都要等滿 15 秒
    // 然後以 exit code 1 結束（systemd／Docker 會判讀成當掉）。
    try { realtime.closeAll(wss); } catch {}
    try { retention.stop(); } catch {}
    try { require('./lib/grade').stopSweep(); } catch {}
    server.close(async () => {
      await db.close();
      clearTimeout(force);
      console.log('已安全關閉');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
  process.on('uncaughtException', (e) => {
    // 記下來但不要直接死掉：考試進行中被一個非致命例外整個打掉最糟
    console.error('[uncaughtException]', e);
  });

  return server;
}

if (require.main === module) {
  start().catch((e) => { console.error('啟動失敗：', e); process.exit(1); });
}

module.exports = { app, start };
