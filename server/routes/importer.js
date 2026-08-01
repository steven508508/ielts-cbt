'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireStaff } = require('../middleware/auth');
const { validatePaper, normalizePaper } = require('../lib/paper');
const tabular = require('../lib/tabular');
const aiTasks = require('../lib/aiTasks');

const router = express.Router();
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

router.use(requireAuth, requireStaff);

/** 下載 Excel 範本 */
router.get('/template.xlsx', (req, res) => {
  const buf = tabular.buildTemplate();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="ielts-question-template.xlsx"');
  res.send(buf);
});

/** ① JSON 匯入（貼上或上傳 .json） */
router.post('/json', memUpload.single('file'), async (req, res) => {
  let paper;
  try {
    paper = req.file ? JSON.parse(req.file.buffer.toString('utf8')) : req.body.paper;
    if (typeof paper === 'string') paper = JSON.parse(paper);
  } catch (e) {
    return res.status(400).json({ error: 'JSON 格式錯誤：' + e.message });
  }
  const result = validatePaper(paper);
  res.json({ ok: result.ok, errors: result.errors, warnings: result.warnings, stats: result.stats, paper: result.paper });
});

/** ② Excel / CSV 匯入 */
router.post('/spreadsheet', memUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
  let rows;
  try {
    rows = tabular.readRows(req.file.buffer, req.file.originalname);
  } catch (e) {
    return res.status(400).json({ error: '無法讀取檔案：' + e.message });
  }
  if (!rows.length)
    return res.status(400).json({ error: '找不到可用的資料列。請確認第一列是欄位名稱，且至少含有 module 與 type 欄。' });

  const { paper, notes } = tabular.rowsToPaper(rows, {
    title: req.body.title || req.file.originalname.replace(/\.\w+$/, ''),
    testType: req.body.testType || 'academic',
    description: req.body.description || '',
  });
  const result = validatePaper(paper);
  res.json({
    ok: result.ok, errors: result.errors, warnings: [...notes, ...result.warnings],
    stats: result.stats, paper: result.paper, rowCount: rows.length,
  });
});

/** ③ 貼上原文，交給 AI 解析 */
router.post('/parse', async (req, res) => {
  const { text, moduleHint, answerKey, title, testType } = req.body || {};
  if (!text || String(text).trim().length < 30)
    return res.status(400).json({ error: '請貼上完整的題目內容' });
  try {
    const parsed = await aiTasks.parsePasted({ text, moduleHint, answerKey, userId: req.user.id });
    const mod = parsed.module || moduleHint || 'reading';
    const sections = parsed.sections || [];

    // AI 有時候只回題目、把文章漏掉（尤其貼進來的是「文章＋題目」混在一起時）。
    // 閱讀少了文章，學生端就只剩題目，所以退而求其次：把老師貼的原文整段放進去，
    // 並在提醒裡講清楚要人工確認。
    const notes = [...(parsed.notes || [])];
    if (mod === 'reading' && sections.length === 1 && !sections[0].passage) {
      sections[0].passage = String(text);
      notes.push('AI 沒有回傳文章內容，已把你貼上的原文整段放進「文章」欄位，請確認有沒有把題目也混進去。');
    }

    const paper = normalizePaper({
      title: title || 'AI 解析的試卷',
      testType: testType || 'academic',
      modules: [{ module: mod, sections }],
    });
    const result = validatePaper(paper);
    res.json({
      ok: result.ok, errors: result.errors,
      warnings: [...notes.map((n) => `AI 提醒：${n}`), ...result.warnings],
      stats: result.stats, paper: result.paper,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** ④ 合併：把一個 module 併進既有試卷 */
router.post('/merge', async (req, res) => {
  const { testId, paper: incoming } = req.body || {};
  const row = await db.one('SELECT * FROM tests WHERE id = ?', [testId]);
  if (!row) return res.status(404).json({ error: '找不到試卷' });
  const base = normalizePaper(JSON.parse(row.content));
  const add = normalizePaper(incoming);

  for (const mod of add.modules) {
    const exist = base.modules.find((m) => m.module === mod.module);
    if (exist) exist.sections.push(...mod.sections);
    else base.modules.push(mod);
  }
  const result = validatePaper(base);
  if (!result.ok) return res.status(400).json({ error: '合併後格式有誤', errors: result.errors });
  await db.exec('UPDATE tests SET content = ? WHERE id = ?', [JSON.stringify(result.paper), testId]);
  res.json({ ok: true, warnings: result.warnings, stats: result.stats });
});

/** 匯出試卷 JSON */
router.get('/export/:id', async (req, res) => {
  const row = await db.one('SELECT * FROM tests WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '找不到試卷' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="test-${row.id}.json"`);
  res.send(row.content);
});

module.exports = router;
