'use strict';
/**
 * 考前環境診斷的伺服器端。
 *
 * 這支端點是「不用登入」就能打的，所以每一個欄位都要當成敵意輸入處理：
 * 只收白名單裡的檢查項目、每個欄位都截斷、整包大小設上限。
 * 學生登入之後再跑一次，就會綁到他的帳號。
 */
const crypto = require('crypto');
const db = require('../db');

/** 診斷項目。critical = 這一項不過就不該讓他去考。 */
const CHECKS = {
  browser: { label: '瀏覽器', critical: false },
  secure: { label: '安全連線', critical: true },
  server: { label: '伺服器連線', critical: true },
  clock: { label: '電腦時鐘', critical: false },
  screen: { label: '螢幕大小', critical: false },
  storage: { label: '瀏覽器儲存', critical: true },
  fullscreen: { label: '全螢幕', critical: false },
  speaker: { label: '喇叭／耳機', critical: false },
  audio: { label: '聽力音檔格式', critical: false },
  mic: { label: '麥克風', critical: true },
  ws: { label: '口說即時通道', critical: false },
  turnstile: { label: '人機驗證', critical: false },
};

const STATUSES = ['pass', 'warn', 'fail', 'skip'];

/** 產生一組好唸的短碼，避開容易看錯的 0/O、1/I */
const ALPHABET = '23456789ACDEFGHJKLMNPQRTUVWXY';
function makeCode() {
  const buf = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i += 1) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

/**
 * 把前端送來的結果清乾淨。
 * 回傳 { results, score, ok, summary, criticalFails }
 */
function sanitize(raw) {
  const results = {};
  for (const [id, meta] of Object.entries(CHECKS)) {
    const r = raw && typeof raw === 'object' ? raw[id] : null;
    if (!r || typeof r !== 'object') { results[id] = { status: 'skip', note: '' }; continue; }
    const status = STATUSES.includes(r.status) ? r.status : 'skip';
    results[id] = {
      status,
      label: meta.label,
      note: String(r.note == null ? '' : r.note).slice(0, 120),
    };
  }

  const graded = Object.values(results).filter((r) => r.status !== 'skip');
  const passed = graded.filter((r) => r.status === 'pass').length;
  const score = graded.length ? Math.round((passed / graded.length) * 100) : 0;

  const criticalFails = Object.entries(results)
    .filter(([id, r]) => CHECKS[id].critical && r.status === 'fail')
    .map(([id]) => CHECKS[id].label);

  const problems = Object.entries(results)
    .filter(([, r]) => r.status === 'fail' || r.status === 'warn')
    .map(([id, r]) => `${CHECKS[id].label}${r.note ? `：${r.note}` : ''}`);

  return {
    results,
    score,
    ok: criticalFails.length === 0 && !problems.length,
    criticalFails,
    summary: problems.length ? problems.join('；').slice(0, 300) : '全部通過',
  };
}

/** 同一個人／同一台電腦最多留幾筆。學生考前會反覆重測，不控制的話一天就好幾十筆。 */
const KEEP_PER_USER = 5;
const KEEP_PER_IP = 3;
const HARD_KEEP_DAYS = 90;

/**
 * 只留最近幾筆。
 *
 * 不能寫成 DELETE ... WHERE id NOT IN (SELECT ... LIMIT n) ——
 * MySQL 不允許在 DELETE 的子查詢裡讀同一張表。先把界線查出來再刪，
 * 走 index 也比較快。
 */
async function trim(where, params, keep) {
  const rows = await db.query(
    `SELECT id FROM device_checks WHERE ${where} ORDER BY id DESC LIMIT ${keep}`, params);
  if (rows.length < keep) return 0;
  const r = await db.exec(
    `DELETE FROM device_checks WHERE ${where} AND id < ?`, [...params, rows[rows.length - 1].id]);
  return r?.affectedRows || 0;
}

async function save({ raw, userId = null, ua = '', ip = '' }) {
  const clean = sanitize(raw);
  const code = makeCode();
  await db.exec(
    `INSERT INTO device_checks (user_id, code, ok, score, summary, results, ua, ip)
     VALUES (?,?,?,?,?,?,?,?)`,
    [userId, code, clean.ok ? 1 : 0, clean.score, clean.summary,
      JSON.stringify(clean.results), String(ua || '').slice(0, 255), String(ip || '').slice(0, 45)]
  ).catch((e) => { console.warn('[devicecheck] 寫入失敗：', e.message); });

  // 每次寫入順手修剪。這一段的成敗完全不影響學生，所以整包吞掉錯誤。
  // 放在這裡而不是只靠每晚的自動清理，是因為自動清理預設是關的 ——
  // 老師沒開的話這張表會一直長，而學生考前重測又特別頻繁。
  try {
    if (userId) await trim('user_id = ?', [userId], KEEP_PER_USER);
    else if (ip) await trim('user_id IS NULL AND ip = ?', [String(ip).slice(0, 45)], KEEP_PER_IP);
    // 再兜個底：超過 90 天的一律清掉，一次最多 200 筆，不會拖慢這支請求
    await db.exec(
      `DELETE FROM device_checks
        WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 200`, [HARD_KEEP_DAYS]);
  } catch (e) { console.warn('[devicecheck] 修剪失敗：', e.message); }

  return { ...clean, code };
}

/** 老師端：最近的診斷紀錄 */
async function list({ limit = 100, userId = null, onlyProblems = false } = {}) {
  const where = [];
  const params = [];
  if (userId) { where.push('d.user_id = ?'); params.push(Number(userId)); }
  if (onlyProblems) where.push('d.ok = 0');
  const rows = await db.query(
    `SELECT d.id, d.code, d.ok, d.score, d.summary, d.ua, d.created_at,
            u.name AS user_name, u.username, u.class_group
       FROM device_checks d
       LEFT JOIN users u ON u.id = d.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.id DESC
      LIMIT ${Math.min(500, Math.max(1, Number(limit) || 100))}`,
    params
  );
  return rows;
}

/** 清掉太舊的診斷紀錄 */
async function cleanup(days = 30) {
  const r = await db.exec(
    'DELETE FROM device_checks WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
    [Number(days) || 30]
  );
  return r?.affectedRows || 0;
}

module.exports = {
  CHECKS, STATUSES, sanitize, save, list, cleanup, makeCode, trim,
  KEEP_PER_USER, KEEP_PER_IP, HARD_KEEP_DAYS,
};
