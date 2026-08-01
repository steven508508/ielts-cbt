'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireStaff } = require('../middleware/auth');
const { validatePaper, normalizePaper, countQuestions, QUESTION_TYPES } = require('../lib/paper');

const router = express.Router();
router.use(requireAuth);

// 題型清單（前端編輯器與 AI 出題頁使用）
router.get('/question-types', (req, res) => res.json({ types: QUESTION_TYPES }));

router.get('/', async (req, res) => {
  const staff = req.user.role !== 'student';
  const rows = await db.query(
    `SELECT t.id, t.title, t.test_type, t.description, t.published, t.created_at, t.updated_at,
            u.name AS author
     FROM tests t LEFT JOIN users u ON u.id = t.created_by
     ${staff ? '' : 'WHERE t.published = 1'}
     ORDER BY t.updated_at DESC`
  );
  res.json({ tests: rows });
});

router.get('/:id', async (req, res) => {
  const row = await db.one('SELECT * FROM tests WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '找不到試卷' });
  if (req.user.role === 'student') return res.status(403).json({ error: '權限不足' });
  const paper = JSON.parse(row.content);
  res.json({
    test: {
      id: row.id, title: row.title, testType: row.test_type, description: row.description,
      published: !!row.published, createdAt: row.created_at, updatedAt: row.updated_at,
    },
    paper,
    stats: {
      listening: countQuestions(paper, 'listening'),
      reading: countQuestions(paper, 'reading'),
    },
  });
});

router.post('/validate', requireStaff, (req, res) => {
  const result = validatePaper(req.body?.paper);
  res.json({ ok: result.ok, errors: result.errors, warnings: result.warnings, stats: result.stats });
});

router.post('/', requireStaff, async (req, res) => {
  const { paper } = req.body || {};
  const result = validatePaper(paper);
  if (!result.ok) return res.status(400).json({ error: '試卷格式有誤', errors: result.errors, warnings: result.warnings });
  const p = result.paper;
  const id = await db.insert(
    'INSERT INTO tests (title, test_type, description, content, published, created_by) VALUES (?,?,?,?,?,?)',
    [p.title, p.testType, p.description || null, JSON.stringify(p), req.body.published ? 1 : 0, req.user.id]
  );
  res.json({ id, warnings: result.warnings, stats: result.stats });
});

router.put('/:id', requireStaff, async (req, res) => {
  const row = await db.one('SELECT id FROM tests WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '找不到試卷' });

  if (req.body.paper) {
    const result = validatePaper(req.body.paper);
    if (!result.ok) return res.status(400).json({ error: '試卷格式有誤', errors: result.errors, warnings: result.warnings });
    const p = result.paper;
    await db.exec(
      'UPDATE tests SET title=?, test_type=?, description=?, content=?, published=? WHERE id=?',
      [p.title, p.testType, p.description || null, JSON.stringify(p),
       req.body.published != null ? (req.body.published ? 1 : 0) : 0, req.params.id]
    );
    return res.json({ ok: true, warnings: result.warnings, stats: result.stats });
  }
  if (req.body.published != null) {
    await db.exec('UPDATE tests SET published=? WHERE id=?', [req.body.published ? 1 : 0, req.params.id]);
  }
  res.json({ ok: true });
});

router.delete('/:id', requireStaff, async (req, res) => {
  await db.exec('DELETE FROM tests WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

router.post('/:id/duplicate', requireStaff, async (req, res) => {
  const row = await db.one('SELECT * FROM tests WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '找不到試卷' });
  const paper = normalizePaper(JSON.parse(row.content));
  paper.title = `${paper.title}（複本）`;
  const id = await db.insert(
    'INSERT INTO tests (title, test_type, description, content, published, created_by) VALUES (?,?,?,?,0,?)',
    [paper.title, row.test_type, row.description, JSON.stringify(paper), req.user.id]
  );
  res.json({ id });
});

// ── 指派 ───────────────────────────────────────────────────────
router.get('/assignments/all', requireStaff, async (req, res) => {
  const rows = await db.query(
    `SELECT a.*, t.title AS test_title, u.name AS student_name
     FROM assignments a
     JOIN tests t ON t.id = a.test_id
     LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC`
  );
  res.json({ assignments: rows });
});

router.post('/assignments', requireStaff, async (req, res) => {
  const {
    testId, userIds = [], classGroup = null,
    modules = 'listening,reading,writing,speaking',
    speakingGrading = 'ai', writingGrading = 'ai',
    openFrom = null, openUntil = null, maxAttempts = 1,
  } = req.body || {};
  if (!testId) return res.status(400).json({ error: '請選擇試卷' });

  const made = [];
  if (classGroup) {
    made.push(await db.insert(
      `INSERT INTO assignments (test_id, class_group, modules, speaking_grading, writing_grading, open_from, open_until, max_attempts, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [testId, classGroup, modules, speakingGrading, writingGrading, openFrom, openUntil, maxAttempts, req.user.id]
    ));
  }
  for (const uid of userIds) {
    made.push(await db.insert(
      `INSERT INTO assignments (test_id, user_id, modules, speaking_grading, writing_grading, open_from, open_until, max_attempts, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [testId, uid, modules, speakingGrading, writingGrading, openFrom, openUntil, maxAttempts, req.user.id]
    ));
  }
  await db.exec('UPDATE tests SET published = 1 WHERE id = ?', [testId]);
  res.json({ ids: made });
});

router.delete('/assignments/:id', requireStaff, async (req, res) => {
  await db.exec('DELETE FROM assignments WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
