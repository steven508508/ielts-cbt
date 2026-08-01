'use strict';
/** 教師端：檔案、考試資料、成績的管理與清理服務。 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireAuth, requireStaff, requireRole } = require('../middleware/auth');
const retention = require('../lib/retention');

const router = express.Router();
router.use(requireAuth, requireStaff);

const idList = (ids) => (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);

// ── 總覽：空間、筆數、最舊資料 ────────────────────────────────
router.get('/overview', async (req, res) => {
  const counts = {};
  for (const t of ['users', 'tests', 'assignments', 'attempts', 'answers', 'writing_responses',
    'speaking_responses', 'module_results', 'media', 'question_bank', 'ai_logs']) {
    const r = await db.one(`SELECT COUNT(*) AS n FROM \`${t}\``);
    counts[t] = Number(r?.n || 0);
  }

  const dbSize = await db.one(
    `SELECT SUM(data_length + index_length) AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
    [config.db.database]
  );

  const storage = {};
  let totalBytes = 0;
  for (const kind of ['audio', 'image', 'speaking']) {
    const s = retention.dirSize(path.join(config.UPLOAD_DIR, kind));
    storage[kind] = s;
    totalBytes += s.bytes;
  }

  const oldest = await db.one(
    "SELECT MIN(COALESCE(submitted_at, started_at)) AS d FROM attempts WHERE status <> 'in_progress'"
  );
  const byStatus = await db.query('SELECT status, COUNT(*) AS n FROM attempts GROUP BY status');
  const byYear = await db.query(
    `SELECT DATE_FORMAT(COALESCE(submitted_at, started_at), '%Y-%m') AS ym, COUNT(*) AS n
     FROM attempts GROUP BY ym ORDER BY ym DESC LIMIT 24`
  );
  const unused = await retention.findUnusedMedia();

  res.json({
    counts,
    dbBytes: Number(dbSize?.bytes || 0),
    storage: { ...storage, totalBytes },
    oldestResult: oldest?.d || null,
    byStatus,
    byMonth: byYear,
    unusedMedia: { count: unused.length, bytes: unused.reduce((n, m) => n + Number(m.size || 0), 0) },
    policy: await retention.getPolicy(),
  });
});

// ── Cloudflare Turnstile 人機驗證 ─────────────────────────────
const turnstile = require('../lib/turnstile');

router.get('/turnstile', async (req, res) => {
  res.json({ turnstile: turnstile.maskConfig(await turnstile.getConfig(true)) });
});

router.put('/turnstile', requireRole('admin'), async (req, res) => {
  const t = req.body?.turnstile || {};
  const patch = {};
  if (t.enabled !== undefined) patch.enabled = !!t.enabled;
  if (t.failOpen !== undefined) patch.failOpen = !!t.failOpen;
  if (t.siteKey !== undefined) patch.siteKey = String(t.siteKey).trim();
  // 前端送回遮罩過的字串時不要覆寫
  if (t.secretKey !== undefined && !/••••/.test(String(t.secretKey))) {
    patch.secretKey = String(t.secretKey).trim();
  }
  const next = await turnstile.saveConfig(patch);
  res.json({ ok: true, turnstile: turnstile.maskConfig(next) });
});

/** 用目前設定實際打一次 Cloudflare，確認 Secret Key 有效 */
router.post('/turnstile/test', requireRole('admin'), async (req, res) => {
  const c = await turnstile.getConfig(true);
  if (!c.secretKey) return res.status(400).json({ ok: false, error: '尚未填入 Secret Key' });
  try {
    // 一定要有逾時。少了它，Cloudflare 沒回應時這個請求會一直掛著，
    // 後台按下「測試」就永遠轉圈。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let r;
    try {
      r = await fetch(turnstile.VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: c.secretKey, response: 'connectivity-test-token' }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const data = await r.json();
    const codes = data['error-codes'] || [];
    // 用假 token 一定會失敗；重點是看是不是「token 無效」而不是「secret 無效」
    if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
      return res.json({ ok: false, error: 'Secret Key 無效，Cloudflare 不認得這把金鑰', codes });
    }
    res.json({ ok: true, message: 'Cloudflare 連線正常，Secret Key 看起來有效', codes });
  } catch (e) {
    const why = (e?.name === 'AbortError' || /aborted/i.test(e?.message || ''))
      ? '伺服器在 10 秒內連不上 Cloudflare（可能是防火牆或 DNS 擋住了 challenges.cloudflare.com）'
      : e.message;
    res.status(502).json({ ok: false, error: `無法連線到 Cloudflare：${why}` });
  }
});

// ── 保留政策 ──────────────────────────────────────────────────
router.get('/policy', async (req, res) => res.json({ policy: await retention.getPolicy() }));

router.put('/policy', requireRole('admin'), async (req, res) => {
  const p = req.body?.policy || {};
  const clean = {};
  for (const k of ['keepResultsMonths', 'keepSpeakingAudioMonths', 'keepAbandonedDays',
    'keepAiLogsDays', 'keepReadNotificationsDays', 'keepDeviceChecksDays',
    'keepExamEventsDays', 'keepMaintenanceLogDays',
    'deleteUnusedMediaDays', 'runAtHour']) {
    if (p[k] !== undefined) clean[k] = Math.max(0, Number(p[k]) || 0);
  }
  if (p.enabled !== undefined) clean.enabled = !!p.enabled;
  res.json({ policy: await retention.savePolicy(clean) });
});

/** 試算 / 執行清理 */
router.post('/cleanup', async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  if (!dryRun && req.user.role !== 'admin')
    return res.status(403).json({ error: '只有管理員能實際執行清理' });
  try {
    const report = await retention.runCleanup({
      dryRun,
      policy: req.body?.policy ? { ...(await retention.getPolicy()), ...req.body.policy } : null,
      actor: req.user.username,
    });
    res.json({ report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/log', async (req, res) => {
  const rows = await db.query('SELECT * FROM maintenance_log ORDER BY id DESC LIMIT 100');
  res.json({
    log: rows.map((r) => {
      let detail = null;
      try { detail = JSON.parse(r.detail || 'null'); } catch { detail = r.detail; }
      return { ...r, detail };
    }),
  });
});

// ── 檔案管理 ──────────────────────────────────────────────────
router.get('/media', async (req, res) => {
  const { kind, folder, q, unusedOnly } = req.query;
  const where = [];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (folder) { where.push('folder = ?'); params.push(folder); }
  if (q) { where.push('(original_name LIKE ? OR label LIKE ? OR tags LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = await db.query(
    `SELECT m.*, u.name AS uploader FROM media m LEFT JOIN users u ON u.id = m.uploaded_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC LIMIT 2000`,
    params
  );

  // 標記哪些檔案有被試卷引用。
  // 舊寫法把每一份試卷的 content（LONGTEXT，整份試卷）全撈進記憶體，
  // 再跑 O(試卷數 × 檔案數) 的字串比對 —— 幾百份試卷就是幾十 MB 的字串。
  // 改成讓資料庫去比對，一個檔案一次查詢，而且只回傳 id 與標題。
  const usage = new Map();
  for (const m of rows) {
    const hits = await db.query(
      "SELECT id, title FROM tests WHERE content LIKE CONCAT('%', ?, '%') LIMIT 5",
      [m.filename]
    );
    if (hits.length) usage.set(m.id, hits.map((t) => ({ id: t.id, title: t.title })));
  }

  let media = rows.map((m) => ({
    id: m.id, url: `/uploads/${m.kind}/${m.filename}`, name: m.original_name,
    kind: m.kind, size: Number(m.size), label: m.label, folder: m.folder, tags: m.tags,
    uploader: m.uploader, createdAt: m.created_at,
    usedBy: usage.get(m.id) || [],
  }));
  if (unusedOnly === '1') media = media.filter((m) => m.usedBy.length === 0);

  const folders = await db.query(
    "SELECT folder AS name, COUNT(*) AS n, SUM(size) AS bytes FROM media WHERE folder IS NOT NULL AND folder <> '' GROUP BY folder ORDER BY folder"
  );
  res.json({
    media, folders,
    total: { count: media.length, bytes: media.reduce((n, m) => n + m.size, 0) },
  });
});

router.put('/media/:id', async (req, res) => {
  const { label, folder, tags } = req.body || {};
  await db.exec('UPDATE media SET label = ?, folder = ?, tags = ? WHERE id = ?',
    [label || null, folder || null, tags || null, req.params.id]);
  res.json({ ok: true });
});

router.post('/media/bulk', async (req, res) => {
  const { action, ids, folder } = req.body || {};
  const list = idList(ids);
  if (!list.length) return res.status(400).json({ error: '沒有選取檔案' });

  if (action === 'move') {
    // list 已經過整數驗證，folder 走參數化
    await db.exec(`UPDATE media SET folder = ? WHERE id IN (${list.join(',')})`, [folder || null]);
    return res.json({ ok: true, moved: list.length });
  }
  if (action === 'delete') {
    const rows = await db.query(`SELECT * FROM media WHERE id IN (${list.join(',')})`);
    // 保護：正在被試卷使用的檔案不允許直接刪
    const tests = await db.query('SELECT content FROM tests');
    const hay = tests.map((t) => t.content).join('\n');
    const blocked = rows.filter((m) => hay.includes(m.filename));
    if (blocked.length && !req.body.force) {
      return res.status(409).json({
        error: `有 ${blocked.length} 個檔案仍被試卷使用`,
        blocked: blocked.map((m) => m.original_name),
      });
    }
    let freed = 0;
    for (const m of rows) freed += retention.rmrf(path.join(config.UPLOAD_DIR, m.kind, m.filename));
    await db.raw(`DELETE FROM media WHERE id IN (${list.join(',')})`);
    await db.exec('INSERT INTO maintenance_log (action, detail, affected, freed_bytes, actor) VALUES (?,?,?,?,?)',
      ['media_delete', JSON.stringify(rows.map((m) => m.original_name).slice(0, 50)), rows.length, freed, req.user.username]);
    return res.json({ ok: true, deleted: rows.length, freedBytes: freed });
  }
  res.status(400).json({ error: '未知的動作' });
});

// ── 考試資料（試卷）管理 ──────────────────────────────────────
router.get('/tests', async (req, res) => {
  const rows = await db.query(
    `SELECT t.id, t.title, t.test_type, t.published, t.archived, t.created_at, t.updated_at,
            LENGTH(t.content) AS content_bytes,
            u.name AS author,
            (SELECT COUNT(*) FROM attempts a WHERE a.test_id = t.id) AS attempts,
            (SELECT COUNT(*) FROM assignments g WHERE g.test_id = t.id) AS assignments
     FROM tests t LEFT JOIN users u ON u.id = t.created_by
     ORDER BY t.archived, t.updated_at DESC`
  );
  res.json({ tests: rows });
});

router.post('/tests/bulk', async (req, res) => {
  const { action, ids } = req.body || {};
  const list = idList(ids);
  if (!list.length) return res.status(400).json({ error: '沒有選取試卷' });

  if (action === 'archive' || action === 'unarchive') {
    const v = action === 'archive' ? 1 : 0;
    await db.raw(`UPDATE tests SET archived = ${v}${v ? ', published = 0' : ''} WHERE id IN (${list.join(',')})`);
    return res.json({ ok: true, affected: list.length });
  }
  if (action === 'publish' || action === 'unpublish') {
    await db.raw(`UPDATE tests SET published = ${action === 'publish' ? 1 : 0} WHERE id IN (${list.join(',')})`);
    return res.json({ ok: true, affected: list.length });
  }
  if (action === 'delete') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '只有管理員能刪除試卷' });
    const used = await db.query(
      `SELECT test_id, COUNT(*) AS n FROM attempts WHERE test_id IN (${list.join(',')}) GROUP BY test_id`
    );
    const total = used.reduce((n, r) => n + Number(r.n), 0);
    if (total && !req.body.force) {
      return res.status(409).json({
        error: `這些試卷底下還有 ${total} 筆考試紀錄，刪除會一併移除。確定要刪請再按一次。`,
        attempts: total, needsForce: true,
      });
    }
    let freed = 0;
    const attempts = await db.query(`SELECT id FROM attempts WHERE test_id IN (${list.join(',')})`);
    for (const a of attempts) freed += retention.rmrf(path.join(config.UPLOAD_DIR, 'speaking', String(a.id)));
    await db.raw(`DELETE FROM tests WHERE id IN (${list.join(',')})`);
    await db.exec('INSERT INTO maintenance_log (action, detail, affected, freed_bytes, actor) VALUES (?,?,?,?,?)',
      ['tests_delete', JSON.stringify(list), list.length, freed, req.user.username]);
    return res.json({ ok: true, deleted: list.length, freedBytes: freed });
  }
  res.status(400).json({ error: '未知的動作' });
});

// ── 成績管理 ──────────────────────────────────────────────────
function resultFilterSql(q) {
  const where = [];
  const params = [];
  if (q.testId) { where.push('a.test_id = ?'); params.push(Number(q.testId)); }
  if (q.classGroup) { where.push('u.class_group = ?'); params.push(q.classGroup); }
  if (q.status) { where.push('a.status = ?'); params.push(q.status); }
  if (q.userId) { where.push('a.user_id = ?'); params.push(Number(q.userId)); }
  if (q.from) { where.push('COALESCE(a.submitted_at, a.started_at) >= ?'); params.push(q.from); }
  if (q.to) { where.push('COALESCE(a.submitted_at, a.started_at) <= ?'); params.push(`${q.to} 23:59:59`); }
  if (q.beforeMonths) {
    where.push('COALESCE(a.submitted_at, a.started_at) < DATE_SUB(NOW(), INTERVAL ? MONTH)');
    params.push(Number(q.beforeMonths));
  }
  if (q.archived === '1') where.push('a.archived = 1');
  if (q.archived === '0') where.push('a.archived = 0');
  if (q.minBand) { where.push('a.overall_band >= ?'); params.push(Number(q.minBand)); }
  if (q.maxBand) { where.push('a.overall_band <= ?'); params.push(Number(q.maxBand)); }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

router.get('/results', async (req, res) => {
  const { clause, params } = resultFilterSql(req.query);
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
  const rows = await db.query(
    `SELECT a.id, a.status, a.archived, a.started_at, a.submitted_at, a.modules,
            a.listening_band, a.reading_band, a.writing_band, a.speaking_band, a.overall_band,
            u.id AS user_id, u.name AS student_name, u.username, u.class_group, u.candidate_no,
            t.id AS test_id, t.title AS test_title
     FROM attempts a JOIN users u ON u.id = a.user_id JOIN tests t ON t.id = a.test_id
     ${clause}
     ORDER BY COALESCE(a.submitted_at, a.started_at) DESC
     LIMIT ${limit}`,
    params
  );
  const agg = await db.one(
    `SELECT COUNT(*) AS n, AVG(a.overall_band) AS avg_band
     FROM attempts a JOIN users u ON u.id = a.user_id ${clause}`,
    params
  );
  res.json({
    results: rows,
    summary: { count: Number(agg?.n || 0), avgBand: agg?.avg_band == null ? null : Number(agg.avg_band) },
    truncated: rows.length >= limit,
  });
});

router.post('/results/bulk', async (req, res) => {
  const { action, ids, filter, force } = req.body || {};
  let targets = idList(ids);

  // 也可以用條件批次選取（例如「刪除 12 個月前的成績」）
  if (!targets.length && filter) {
    const { clause, params } = resultFilterSql(filter);
    if (!clause) return res.status(400).json({ error: '為了安全，批次操作必須指定條件' });
    const rows = await db.query(
      `SELECT a.id FROM attempts a JOIN users u ON u.id = a.user_id ${clause}`, params
    );
    targets = rows.map((r) => r.id);
  }
  if (!targets.length) return res.json({ ok: true, affected: 0, message: '沒有符合的資料' });

  if (action === 'archive' || action === 'unarchive') {
    await db.raw(`UPDATE attempts SET archived = ${action === 'archive' ? 1 : 0} WHERE id IN (${targets.join(',')})`);
    return res.json({ ok: true, affected: targets.length });
  }

  if (action === 'preview') {
    return res.json({ ok: true, affected: targets.length, ids: targets.slice(0, 200) });
  }

  if (action === 'delete') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '只有管理員能刪除成績' });
    if (targets.length > 20 && !force) {
      return res.status(409).json({
        error: `這會刪除 ${targets.length} 筆成績且無法復原，請確認後再執行。`,
        affected: targets.length, needsForce: true,
      });
    }
    let freed = 0;
    for (const id of targets) freed += retention.rmrf(path.join(config.UPLOAD_DIR, 'speaking', String(id)));
    // 分批刪，避免 SQL 太長
    for (let i = 0; i < targets.length; i += 500) {
      const chunk = targets.slice(i, i + 500);
      await db.raw(`DELETE FROM attempts WHERE id IN (${chunk.join(',')})`);
    }
    await db.exec('INSERT INTO maintenance_log (action, detail, affected, freed_bytes, actor) VALUES (?,?,?,?,?)',
      ['results_delete', JSON.stringify({ filter: filter || null, count: targets.length }), targets.length, freed, req.user.username]);
    return res.json({ ok: true, deleted: targets.length, freedBytes: freed });
  }
  res.status(400).json({ error: '未知的動作' });
});

/** 匯出成績 CSV（含 BOM，Excel 開啟不亂碼） */
router.get('/results/export.csv', async (req, res) => {
  const { clause, params } = resultFilterSql(req.query);
  const rows = await db.query(
    `SELECT a.id, a.status, a.started_at, a.submitted_at,
            a.listening_band, a.reading_band, a.writing_band, a.speaking_band, a.overall_band,
            u.name AS student_name, u.username, u.class_group, u.candidate_no, t.title AS test_title
     FROM attempts a JOIN users u ON u.id = a.user_id JOIN tests t ON t.id = a.test_id
     ${clause} ORDER BY COALESCE(a.submitted_at, a.started_at) DESC`,
    params
  );
  const head = ['編號', '學生', '帳號', '班級', '考生編號', '試卷', '狀態', '開始時間', '交卷時間',
    '聽力', '閱讀', '寫作', '口說', '總分'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => [r.id, r.student_name, r.username, r.class_group, r.candidate_no,
    r.test_title, r.status, r.started_at, r.submitted_at,
    r.listening_band, r.reading_band, r.writing_band, r.speaking_band, r.overall_band].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ielts-results-${Date.now()}.csv"`);
  res.send('﻿' + [head.join(','), ...body].join('\n'));
});

/** 打包備份：把一份試卷連同所有成績匯出成 JSON */
router.get('/backup/test/:id.json', async (req, res) => {
  const id = Number(req.params.id);
  const test = await db.one('SELECT * FROM tests WHERE id = ?', [id]);
  if (!test) return res.status(404).json({ error: '找不到試卷' });
  const attempts = await db.query('SELECT * FROM attempts WHERE test_id = ?', [id]);
  const ids = attempts.map((a) => a.id);
  const inClause = ids.length ? `WHERE attempt_id IN (${ids.join(',')})` : 'WHERE 1=0';
  const [answers, writing, speaking, results] = await Promise.all([
    db.query(`SELECT * FROM answers ${inClause}`),
    db.query(`SELECT * FROM writing_responses ${inClause}`),
    db.query(`SELECT * FROM speaking_responses ${inClause}`),
    db.query(`SELECT * FROM module_results ${inClause}`),
  ]);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="backup-test-${id}.json"`);
  res.send(JSON.stringify({
    exportedAt: new Date().toISOString(),
    test: { ...test, content: JSON.parse(test.content) },
    attempts, answers, writing, speaking, results,
  }, null, 2));
});

module.exports = router;
