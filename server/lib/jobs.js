'use strict';
/**
 * 背景工作。
 *
 * 為什麼需要這東西：產生一整份試卷（40 題聽力 + 逐字稿、40 題閱讀 + 三篇文章、
 * 寫作、口說）動輒好幾分鐘。塞在一個 HTTP 請求裡等，會被三道牆擋下：
 *   ① AI 端點自己的逾時（本系統預設 180 秒）
 *   ② 反向代理的 proxy_read_timeout
 *   ③ Cloudflare 橘雲對來源回應有硬性 100 秒上限（超過回 524）
 *
 * 所以改成：建立工作 → 立刻回 jobId → 前端每兩秒問一次進度。
 * 老師可以關掉頁面去做別的事，回來再看結果。
 */
const db = require('../db');

const running = new Map();   // jobId → { cancelled: boolean }

function parse(v, fallback = null) {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    step: row.step,
    doneSteps: row.done_steps,
    totalSteps: row.total_steps,
    percent: row.total_steps ? Math.round((row.done_steps / row.total_steps) * 100) : 0,
    params: parse(row.params, {}),
    result: parse(row.result),
    partial: parse(row.partial),
    error: row.error,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create({ kind, params = {}, totalSteps = 1, userId = null }) {
  return db.insert(
    'INSERT INTO ai_jobs (kind, status, total_steps, params, created_by) VALUES (?,?,?,?,?)',
    [kind, 'queued', totalSteps, JSON.stringify(params), userId]
  );
}

async function get(id) {
  return shape(await db.one('SELECT * FROM ai_jobs WHERE id = ?', [id]));
}

async function listFor(userId, { limit = 20, kind = null } = {}) {
  const rows = await db.query(
    `SELECT id, kind, status, step, done_steps, total_steps, error, created_at, updated_at
       FROM ai_jobs
      WHERE created_by = ? ${kind ? 'AND kind = ?' : ''}
      ORDER BY id DESC LIMIT ${Math.min(100, Math.max(1, Number(limit) || 20))}`,
    kind ? [userId, kind] : [userId]
  );
  // 清單刻意不含 params / result / partial —— 結果可能好幾百 KB
  return rows.map((r) => {
    const { result, partial, params, ...light } = shape({ ...r, params: null, result: null, partial: null });
    return light;
  });
}

async function progress(id, { step, doneSteps, partial }) {
  const sets = ['status = ?'];
  const vals = ['running'];
  if (step !== undefined) { sets.push('step = ?'); vals.push(String(step).slice(0, 200)); }
  if (doneSteps !== undefined) { sets.push('done_steps = ?'); vals.push(doneSteps); }
  if (partial !== undefined) { sets.push('partial = ?'); vals.push(JSON.stringify(partial)); }
  vals.push(id);
  await db.exec(`UPDATE ai_jobs SET ${sets.join(', ')} WHERE id = ?`, vals);
}

async function finish(id, result) {
  await db.exec(
    'UPDATE ai_jobs SET status = ?, result = ?, step = ?, done_steps = total_steps WHERE id = ?',
    ['done', JSON.stringify(result), '完成', id]
  );
  running.delete(id);
}

async function fail(id, message) {
  await db.exec('UPDATE ai_jobs SET status = ?, error = ? WHERE id = ?',
    ['error', String(message || '').slice(0, 2000), id]);
  running.delete(id);
}

async function cancel(id) {
  const handle = running.get(id);
  if (handle) handle.cancelled = true;
  await db.exec("UPDATE ai_jobs SET status = 'cancelled', step = '已取消' WHERE id = ? AND status IN ('queued','running')", [id]);
  // 這裡「不能」delete —— 一刪 isCancelled() 就永遠回 false，
  // ctx.check() 檢查不到取消，工作會繼續跑完，最後還把狀態蓋回 done。
  // 交給 run() 的收尾流程移除。
  return get(id);
}

function isCancelled(id) {
  return !!running.get(id)?.cancelled;
}

/**
 * 真正跑起來。fn 會拿到一個 ctx：
 *   ctx.setStep(text, doneSteps)   回報進度
 *   ctx.savePartial(obj)           存下已完成的部分，失敗時老師還能撿回來
 *   ctx.check()                    被取消時丟出例外，用來中止迴圈
 * 注意：這裡刻意「不 await」，讓 HTTP 請求可以立刻回應。
 */
function run(id, fn) {
  running.set(id, { cancelled: false });
  (async () => {
    try {
      await progress(id, { step: '準備中', doneSteps: 0 });
      const ctx = {
        jobId: id,
        setStep: (text, done) => progress(id, { step: text, doneSteps: done }),
        savePartial: (obj) => progress(id, { partial: obj }),
        check: () => { if (isCancelled(id)) throw new Error('__CANCELLED__'); },
        isCancelled: () => isCancelled(id),
      };
      const result = await fn(ctx);
      if (isCancelled(id)) return;
      await finish(id, result);
    } catch (e) {
      if (e.message === '__CANCELLED__') { running.delete(id); return; }
      console.warn(`[job ${id}] 失敗：`, e.message);
      const ai = require('./ai');
      await fail(id, ai.friendlyError(e)).catch(() => {});
    }
  })();
  return id;
}

/** 伺服器重啟時，資料庫裡還卡著 running 的工作其實早就沒了 */
async function reapStale() {
  try {
    const r = await db.exec(
      "UPDATE ai_jobs SET status = 'error', error = ? WHERE status IN ('queued','running')",
      ['伺服器重新啟動，這個工作已中斷。請重新產生一次。']
    );
    if (r?.affectedRows) console.log(`  已標記 ${r.affectedRows} 個中斷的 AI 工作`);
  } catch { /* 資料表還沒建好 */ }
}

/** 清掉太舊的工作紀錄（結果可能很大，不要無限累積） */
async function cleanup(days = 7) {
  const r = await db.exec(
    'DELETE FROM ai_jobs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [Number(days) || 7]);
  return r?.affectedRows || 0;
}

module.exports = { create, get, listFor, progress, finish, fail, cancel, isCancelled, run, reapStale, cleanup };
