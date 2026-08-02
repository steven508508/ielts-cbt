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
  /* 內容安全政策。整個專案以前一條都沒有。
     萬一真的被塞進一段同源的腳本（上傳、題目 HTML、老師貼的內容），
     CSP 是最後一道 —— 只跑自己網域的 js，不准 inline script，
     也不准把偷到的東西往外送。
     style 必須放行 inline：UI.el() 大量使用行內樣式。
     connect-src 要含 ws/wss：口說是 WebSocket。 */
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-src https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '));
  if (config.isProduction && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

/* ── 靜態資源與版本戳 ─────────────────────────────────────
 *
 * 前端沒有打包步驟，index.html 直接寫死 /js/exam.js 這種路徑。
 * 更新伺服器之後，學生的瀏覽器（還有中間的 CDN／反向代理）常常
 * 還抓著舊的 JS 或 CSS —— 新舊混著跑，畫面壞掉的樣子跟程式碼對不起來，
 * 連「他到底跑的是哪一版」都問不出來，這種回報根本沒辦法查。
 *
 * 所以在送出 index.html 的時候，把每個資源後面補上 ?v=<版本>。
 * 版本一變網址就變，快取自然失效；帶了版本的檔案就可以放心讓瀏覽器
 * 長期快取。順便把版本寫進 <meta> 與 window.APP_VERSION，
 * 學生回報問題時看得到自己跑的是哪一版。
 */
const APP_VERSION = require('../package.json').version;
const INDEX_FILE = path.join(config.PUBLIC_DIR, 'index.html');
let indexCache = null;
function indexHtml() {
  if (indexCache && config.isProduction) return indexCache;
  const html = fs.readFileSync(INDEX_FILE, 'utf8')
    .replace(/(src|href)="(\/(?:js|css)\/[^"?]+)"/g, `$1="$2?v=${APP_VERSION}"`)
    // 版本只放在 meta（CSP 不准 inline script）；前端自己去讀這個標籤
    .replace('</head>', `<meta name="app-version" content="${APP_VERSION}">\n</head>`);
  indexCache = html;
  return html;
}
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');   // 這一份一定要重新驗證，否則版本戳永遠更新不了
  res.type('html').send(indexHtml());
});

app.use(express.static(config.PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    // 帶了 ?v= 的才可以長期快取；直接打檔名的（舊連結、爬蟲）一律重新驗證
    if (/[.](?:js|css)$/.test(filePath) && res.req.query && res.req.query.v) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
/* ── /uploads：要驗身分，而且絕不讓它變成可執行的網頁 ────────
 *
 * 以前這裡是 express.static 直接掛上去，前面沒有任何中介層：
 *   · 任何人（連登入都不用）只要猜到路徑，就能下載全校學生的口說錄音。
 *     檔名完全可預測 —— uploads/speaking/<attemptId>/full-interview.webm，
 *     attemptId 就是自增整數，從 1 一路數上去即可。
 *   · Content-Type 由副檔名決定，而副檔名以前是上傳的人說了算，
 *     所以學生可以在同源底下放一個會執行的 .html。
 *
 * 現在：口說錄音只給本人與教職員；所有檔案的 Content-Type 由伺服器
 * 依副檔名指定，白名單以外一律當附件下載。
 *
 * 身分是從 httpOnly cookie 讀的 —— <audio src> 與 <img src> 沒辦法帶
 * Authorization 標頭，這是唯一能讓瀏覽器自然帶上身分的方式。
 */
const { resolveUser, readToken, readCookie, FILE_COOKIE } = require('./middleware/auth');
const { serveHeaders } = require('./lib/uploadSafety');

app.use('/uploads', async (req, res, next) => {
  // 路徑正規化，擋掉 ../ 之類的花樣
  let rel;
  try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch { return res.status(400).end(); }
  const full = path.resolve(config.UPLOAD_DIR, rel);
  if (!full.startsWith(path.resolve(config.UPLOAD_DIR) + path.sep)) return res.status(403).end();
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).end();

  const user = await resolveUser(readToken(req) || readCookie(req, FILE_COOKIE));
  if (!user) return res.status(401).json({ error: '請先登入' });

  // 口說錄音是個人資料：只有本人與教職員
  const m = rel.match(/^speaking\/(\d+)\//);
  if (m && user.role === 'student') {
    const owner = await db.one('SELECT user_id FROM attempts WHERE id = ?', [Number(m[1])]);
    if (!owner || owner.user_id !== user.id) return res.status(403).json({ error: '權限不足' });
  }

  const h = serveHeaders(path.extname(full));
  res.setHeader('Content-Type', h['Content-Type']);
  res.setHeader('Content-Disposition', h['Content-Disposition']);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 個人錄音不可以被中間的代理／CDN 留副本
  res.setHeader('Cache-Control', m ? 'private, no-store' : 'private, max-age=604800');
  res.sendFile(full, { headers: {}, dotfiles: 'deny' }, (err) => { if (err) next(err); });
});

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
api('/api/check', './routes/devicecheck');

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
const examTimer = require('./lib/examTimer');
  const wss = realtime.attach(server);
  // 時限由伺服器自己執行。前端倒數只是顯示 —— 分頁被切到背景、
  // 筆電闔上、分頁關掉，那段 JavaScript 都不會跑，時限就形同虛設。
  examTimer.start();

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
