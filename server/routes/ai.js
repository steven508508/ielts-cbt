'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireStaff, requireRole } = require('../middleware/auth');
const ai = require('../lib/ai');
const aiTasks = require('../lib/aiTasks');
const bands = require('../lib/bands');
const { validatePaper, normalizePaper } = require('../lib/paper');

const router = express.Router();
router.use(requireAuth);

// ── 設定 ───────────────────────────────────────────────────────
router.get('/settings', requireStaff, async (req, res) => {
  const cfg = await ai.getConfig(true);
  const misc = await db.getSettings();
  res.json({
    ai: ai.maskConfig(cfg),
    marking: {
      allowSpellingVariants: misc.allowSpellingVariants !== false,
      hyphenEqualsSpace: misc.hyphenEqualsSpace !== false,
      expandContractions: misc.expandContractions !== false,
      bandTables: misc.bandTables || bands.DEFAULT_TABLES,
    },
  });
});

router.put('/settings', requireRole('admin'), async (req, res) => {
  const patch = { ...(req.body?.ai || {}) };
  delete patch._hasAnthropicKey; delete patch._hasOpenaiKey; delete patch._hasCustomKey;
  // 前端送回遮罩過的金鑰時不要覆寫
  for (const k of ['anthropicApiKey', 'openaiApiKey', 'customApiKey']) {
    if (patch[k] === undefined || /••••/.test(String(patch[k]))) delete patch[k];
  }
  const cfg = await ai.saveConfig(patch);

  const marking = req.body?.marking || {};
  for (const k of ['allowSpellingVariants', 'hyphenEqualsSpace', 'expandContractions']) {
    if (marking[k] !== undefined) await db.setSetting(k, !!marking[k]);
  }
  if (marking.bandTables) await db.setSetting('bandTables', marking.bandTables);

  res.json({ ok: true, ai: ai.maskConfig(cfg) });
});

router.post('/test', requireStaff, async (req, res) => {
  try {
    res.json(await ai.testConnection(req.body?.role || 'chat'));
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/logs', requireStaff, async (req, res) => {
  const rows = await db.query('SELECT * FROM ai_logs ORDER BY id DESC LIMIT 100');
  res.json({ logs: rows });
});

// ── 出題 ───────────────────────────────────────────────────────
router.post('/generate', requireStaff, async (req, res) => {
  try {
    const out = await aiTasks.generateQuestions(req.body || {}, req.user.id);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/generate-paper', requireStaff, async (req, res) => {
  try {
    const raw = await aiTasks.generateFullPaper({
      testType: req.body?.testType || 'academic',
      theme: req.body?.theme || '',
      userId: req.user.id,
    });
    const result = validatePaper(normalizePaper(raw));
    res.json({ ok: result.ok, errors: result.errors, warnings: result.warnings, stats: result.stats, paper: result.paper });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/** 存進題庫 */
router.post('/bank', requireStaff, async (req, res) => {
  const { module: mod, type, topic, difficulty, tags, payload, source = 'ai' } = req.body || {};
  const id = await db.insert(
    'INSERT INTO question_bank (module, type, topic, difficulty, tags, payload, source, created_by) VALUES (?,?,?,?,?,?,?,?)',
    [mod, type, topic || null, difficulty || null, tags || null, JSON.stringify(payload), source, req.user.id]
  );
  res.json({ id });
});

router.get('/bank', requireStaff, async (req, res) => {
  const { module: mod, type } = req.query;
  const where = [];
  const params = [];
  if (mod) { where.push('module = ?'); params.push(mod); }
  if (type) { where.push('type = ?'); params.push(type); }
  const rows = await db.query(
    `SELECT id, module, type, topic, difficulty, tags, source, created_at FROM question_bank
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`,
    params
  );
  res.json({ items: rows });
});

router.get('/bank/:id', requireStaff, async (req, res) => {
  const row = await db.one('SELECT * FROM question_bank WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '找不到題組' });
  res.json({ item: { ...row, payload: JSON.parse(row.payload) } });
});

router.delete('/bank/:id', requireStaff, async (req, res) => {
  await db.exec('DELETE FROM question_bank WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ── 單篇寫作立即批改（練習模式，不必整場考試）────────────────
router.post('/grade-writing', async (req, res) => {
  const { taskNo = 2, prompt, essay, testType = 'academic', minWords } = req.body || {};
  if (!essay || String(essay).trim().length < 20) return res.status(400).json({ error: '請貼上作文內容' });
  try {
    const out = await aiTasks.gradeWriting({
      taskNo: Number(taskNo), prompt: prompt || '', essay, testType,
      minWords: minWords || (Number(taskNo) === 2 ? 250 : 150), userId: req.user.id,
    });
    res.json({ ok: true, result: out });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
