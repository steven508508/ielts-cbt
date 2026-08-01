'use strict';
/** 資料保留與自動清理。 */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');

const KEY = 'retention';

const DEFAULT_POLICY = {
  enabled: false,            // 預設關閉，避免誤刪
  keepResultsMonths: 24,     // 成績保留幾個月（0 = 永久）
  keepSpeakingAudioMonths: 6,// 口說錄音檔保留幾個月（成績本身留著）
  keepAbandonedDays: 14,     // 未完成又沒動作的考試場次幾天後清掉
  keepAiLogsDays: 30,        // AI 呼叫紀錄保留幾天
  deleteUnusedMediaDays: 0,  // 沒有任何試卷引用的媒體檔幾天後刪（0 = 不自動刪）
  runAtHour: 3,              // 每天幾點執行（伺服器時間）
};

async function getPolicy() {
  const s = await db.getSettings();
  return { ...DEFAULT_POLICY, ...(s[KEY] || {}) };
}

async function savePolicy(patch) {
  const next = { ...(await getPolicy()), ...patch };
  await db.setSetting(KEY, next);
  return next;
}

// ── 檔案工具 ──────────────────────────────────────────────────
/* 同步走訪整個 uploads/ 會把事件迴圈鎖住 —— 口說錄音一個場次一個資料夾，
   累積上萬個檔案時，老師開一次儀表板就會讓所有正在考試的學生卡住好幾秒。
   加一層 60 秒快取，這個數字本來也不需要即時。 */
const sizeCache = new Map();
const SIZE_TTL = 60_000;

function dirSize(dir) {
  const hit = sizeCache.get(dir);
  if (hit && Date.now() - hit.at < SIZE_TTL) return hit.value;
  const value = dirSizeUncached(dir);
  sizeCache.set(dir, { at: Date.now(), value });
  return value;
}

function dirSizeUncached(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;   // .gitkeep 之類不算
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { bytes += fs.statSync(p).size; files += 1; } catch {}
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

/** 分批刪除。整批塞進一個 IN (...) 會撞上 max_allowed_packet，
    資料一多之後每晚的清理就會固定失敗，而且只留下一行 warn。 */
async function deleteIn(table, ids, chunk = 500) {
  let n = 0;
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk).map(Number).filter(Number.isInteger);
    if (!part.length) continue;
    const r = await db.raw(`DELETE FROM \`${table}\` WHERE id IN (${part.join(',')})`);
    n += r?.affectedRows || 0;
  }
  return n;
}

function rmrf(p) {
  let freed = 0;
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      freed = dirSize(p).bytes;
      fs.rmSync(p, { recursive: true, force: true });
    } else {
      freed = st.size;
      fs.unlinkSync(p);
    }
  } catch {}
  return freed;
}

/** 找出沒有被任何試卷引用的媒體檔 */
async function findUnusedMedia() {
  const media = await db.query(
    'SELECT id, filename, kind, size, original_name, created_at FROM media LIMIT 5000');
  if (!media.length) return [];
  // 不要把整個試卷庫（每份都是 LONGTEXT）拉進記憶體串成一條大字串 ——
  // 兩百份試卷就是幾十 MB，而且這支是儀表板每次載入都會呼叫的。
  const unused = [];
  for (const m of media) {
    const hit = await db.one(
      "SELECT 1 AS x FROM tests WHERE content LIKE CONCAT('%', ?, '%') LIMIT 1", [m.filename]);
    if (!hit) unused.push(m);
  }
  return unused;
}

// ── 清理 ──────────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {boolean} o.dryRun  只計算不刪除
 * @param {object} o.policy   覆寫政策（手動執行時可傳）
 */
async function runCleanup({ dryRun = true, policy = null, actor = 'system' } = {}) {
  const p = policy || (await getPolicy());
  const report = { dryRun, at: new Date().toISOString(), items: [], affected: 0, freedBytes: 0 };

  const add = (action, count, bytes = 0, detail = '') => {
    if (!count && !bytes) return;
    report.items.push({ action, count, bytes, detail });
    report.affected += count;
    report.freedBytes += bytes;
  };

  // 1) 過期的成績（連同作答、錄音一起）
  if (p.keepResultsMonths > 0) {
    const rows = await db.query(
      `SELECT id FROM attempts
       WHERE archived = 0 AND status <> 'in_progress'
         AND COALESCE(submitted_at, started_at) < DATE_SUB(NOW(), INTERVAL ? MONTH)`,
      [p.keepResultsMonths]
    );
    let freed = 0;
    if (!dryRun) {
      for (const r of rows) freed += rmrf(path.join(config.UPLOAD_DIR, 'speaking', String(r.id)));
      if (rows.length) {
        await deleteIn('attempts', rows.map((r) => r.id));
      }
    }
    add('刪除逾期成績', rows.length, freed, `超過 ${p.keepResultsMonths} 個月`);
  }

  // 2) 過期的口說錄音（保留逐字稿與分數）
  if (p.keepSpeakingAudioMonths > 0) {
    const rows = await db.query(
      `SELECT DISTINCT a.id FROM attempts a
       JOIN speaking_responses s ON s.attempt_id = a.id
       WHERE s.audio_path IS NOT NULL
         AND COALESCE(a.submitted_at, a.started_at) < DATE_SUB(NOW(), INTERVAL ? MONTH)`,
      [p.keepSpeakingAudioMonths]
    );
    let freed = 0;
    if (!dryRun) {
      for (const r of rows) freed += rmrf(path.join(config.UPLOAD_DIR, 'speaking', String(r.id)));
      if (rows.length) {
        const ids = rows.map((r) => r.id);
        for (let i = 0; i < ids.length; i += 500) {
          const part = ids.slice(i, i + 500).map(Number).filter(Number.isInteger);
          if (part.length) {
            await db.raw(`UPDATE speaking_responses SET audio_path = NULL WHERE attempt_id IN (${part.join(',')})`);
          }
        }
      }
    }
    add('清除舊口說錄音檔', rows.length, freed, `超過 ${p.keepSpeakingAudioMonths} 個月（逐字稿與分數保留）`);
  }

  // 3) 半途而廢的考試
  if (p.keepAbandonedDays > 0) {
    const rows = await db.query(
      `SELECT id FROM attempts
       WHERE status = 'in_progress' AND started_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [p.keepAbandonedDays]
    );
    let freed = 0;
    if (!dryRun && rows.length) {
      for (const r of rows) freed += rmrf(path.join(config.UPLOAD_DIR, 'speaking', String(r.id)));
      await deleteIn('attempts', rows.map((r) => r.id));
    }
    add('刪除未完成的考試', rows.length, freed, `開始超過 ${p.keepAbandonedDays} 天仍未交卷`);
  }

  // 4) AI 呼叫紀錄
  if (p.keepAiLogsDays > 0) {
    const c = await db.one(
      'SELECT COUNT(*) AS n FROM ai_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [p.keepAiLogsDays]
    );
    const n = Number(c?.n || 0);
    if (!dryRun && n) {
      await db.exec('DELETE FROM ai_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [p.keepAiLogsDays]);
    }
    add('清除 AI 呼叫紀錄', n, 0, `超過 ${p.keepAiLogsDays} 天`);

    // AI 背景工作的結果整份試卷都存在裡面，幾百 KB 起跳，不要無限累積
    const j = await db.one(
      'SELECT COUNT(*) AS n FROM ai_jobs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [p.keepAiLogsDays]
    ).catch(() => null);
    const jn = Number(j?.n || 0);
    if (!dryRun && jn) {
      await db.exec('DELETE FROM ai_jobs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [p.keepAiLogsDays]);
    }
    add('清除 AI 背景工作紀錄', jn, 0, `超過 ${p.keepAiLogsDays} 天（結果已存成試卷的不受影響）`);
  }

  // 5) 沒有被引用的媒體檔
  if (p.deleteUnusedMediaDays > 0) {
    const cutoff = Date.now() - p.deleteUnusedMediaDays * 86400000;
    const unused = (await findUnusedMedia()).filter(
      (m) => new Date(String(m.created_at).replace(' ', 'T')).getTime() < cutoff
    );
    let freed = 0;
    if (!dryRun) {
      for (const m of unused) freed += rmrf(path.join(config.UPLOAD_DIR, m.kind, m.filename));
      if (unused.length) await deleteIn('media', unused.map((m) => m.id));
    } else {
      freed = unused.reduce((n, m) => n + Number(m.size || 0), 0);
    }
    add('刪除未使用的媒體檔', unused.length, freed, `上傳超過 ${p.deleteUnusedMediaDays} 天且沒有試卷引用`);
  }

  if (!dryRun && report.affected) {
    await db.exec(
      'INSERT INTO maintenance_log (action, detail, affected, freed_bytes, actor) VALUES (?,?,?,?,?)',
      ['auto_cleanup', JSON.stringify(report.items), report.affected, report.freedBytes, actor]
    );
  }
  return report;
}

// ── 排程：每小時檢查一次，到指定時間才跑 ──────────────────────
let timer = null;
let firstRun = null;
let lastRunDay = null;

function schedule() {
  if (timer) clearInterval(timer);
  const check = async () => {
    try {
      const p = await getPolicy();
      if (!p.enabled) return;
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      if (day === lastRunDay) return;
      if (now.getHours() !== Number(p.runAtHour)) return;
      const r = await runCleanup({ dryRun: false, policy: p, actor: 'auto' });
      // 成功之後才記錄「今天跑過了」。先設的話，一次失敗就等於整天不再重試。
      lastRunDay = day;
      if (r.affected) console.log(`[retention] 自動清理完成：${r.affected} 筆，釋放 ${(r.freedBytes / 1048576).toFixed(1)} MB`);
    } catch (e) {
      console.warn('[retention] 自動清理失敗，稍後重試：', e.message);
      // 連續失敗要讓老師看得到，不能只留在日誌裡
      await db.exec(
        'INSERT INTO maintenance_log (action, detail, affected, freed_bytes, actor) VALUES (?,?,?,?,?)',
        ['auto_cleanup_failed', JSON.stringify({ error: String(e.message || '').slice(0, 300) }), 0, 0, 'auto']
      ).catch(() => {});
    }
  };
  timer = setInterval(check, 10 * 60 * 1000);
  timer.unref?.();
  firstRun = setTimeout(check, 30000);
  firstRun.unref?.();
  return timer;
}

function stop() {
  clearInterval(timer); timer = null;
  clearTimeout(firstRun); firstRun = null;
}

module.exports = { DEFAULT_POLICY, getPolicy, savePolicy, runCleanup, schedule, stop, findUnusedMedia, dirSize, rmrf, deleteIn };
