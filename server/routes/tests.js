'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireStaff } = require('../middleware/auth');
const { validatePaper, normalizePaper, countQuestions, QUESTION_TYPES } = require('../lib/paper');
const notify = require('../lib/notify');

const examinerLib = require('../lib/examiner');

const router = express.Router();
router.use(requireAuth);

// 題型清單（前端編輯器與 AI 出題頁使用）
router.get('/question-types', (req, res) => res.json({ types: QUESTION_TYPES }));

// 指派畫面用的預設值（官方時間、反作弊預設、休息政策）
router.get('/exam-rules/presets', (req, res) => {
  const { PROCTORING_DEFAULT, BREAK_POLICIES } = require('../lib/examRules');
  const { MODULE_DEFAULTS } = require('../lib/paper');
  res.json({
    officialDurations: Object.fromEntries(
      Object.entries(MODULE_DEFAULTS).map(([k, v]) => [k, v.durationSec + (v.transferSec || 0)])
    ),
    proctoringDefault: PROCTORING_DEFAULT,
    breakPolicies: Object.fromEntries(
      Object.entries(BREAK_POLICIES).map(([k, v]) => [k, { label: v.label, gapSec: v.gapSec }])
    ),
  });
});

router.get('/', async (req, res) => {
  const staff = req.user.role !== 'student';
  const rows = await db.query(
    `SELECT t.id, t.title, t.test_type, t.description, t.published, t.created_at, t.updated_at,
            u.name AS author${staff ? ', t.content' : ''}
     FROM tests t LEFT JOIN users u ON u.id = t.created_by
     ${staff ? '' : 'WHERE t.published = 1'}
     ORDER BY t.updated_at DESC`
  );
  // 老師端順便標出「學生會開天窗」的試卷：閱讀沒文章、聽力沒音檔
  if (staff) {
    for (const r of rows) {
      let n = 0;
      try {
        for (const m of (JSON.parse(r.content).modules || [])) {
          for (const s of (m.sections || [])) {
            if (m.module === 'reading' && !s.passage) n += 1;
            if (m.module === 'listening' && !s.audio) n += 1;
          }
        }
      } catch { /* 內容壞掉就不標 */ }
      r.missingMedia = n;
      delete r.content;
    }
  }
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
    durationOverrides = null,     // { listening: 秒數, … } 留空 = 用試卷預設
    extraTimePct = 0,             // 無障礙加時（%）
    proctoring = null,            // 反作弊設定
    breakPolicy = 'flexible',     // official | timed | flexible
    breakSeconds = 0,
    examiner = null,              // 這一場的 AI 考官設定，留空 = 沿用系統預設
  } = req.body || {};
  if (!testId) return res.status(400).json({ error: '請選擇試卷' });

  // 只留下有填、且是正整數秒數的科目
  const cleanOverrides = {};
  for (const [k, v] of Object.entries(durationOverrides || {})) {
    const n = Number(v);
    if (['listening', 'reading', 'writing', 'speaking'].includes(k) && Number.isFinite(n) && n > 0) {
      cleanOverrides[k] = Math.round(n);
    }
  }
  const overridesJson = Object.keys(cleanOverrides).length ? JSON.stringify(cleanOverrides) : null;
  const proctoringJson = proctoring ? JSON.stringify(proctoring) : null;
  const policy = ['official', 'timed', 'flexible'].includes(breakPolicy) ? breakPolicy : 'flexible';
  const pct = Math.max(0, Math.min(200, Number(extraTimePct) || 0));
  const brk = Math.max(0, Number(breakSeconds) || 0);

  /* 只存「跟系統預設不一樣」的欄位。整組存下來的話，之後管理員改了
     系統預設，這些舊指派會永遠卡在建立當下的那一組值。 */
  let examinerJson = null;
  if (examiner && typeof examiner === 'object') {
    const misc = await db.getSettings();
    const system = examinerLib.normalize(misc.speakingExaminer || {});
    const diff = examinerLib.diffFrom(system, examinerLib.normalize(examiner, system));
    if (Object.keys(diff).length) examinerJson = JSON.stringify(diff);
  }

  const COLS = `(test_id, %TARGET%, modules, speaking_grading, writing_grading, open_from, open_until,
                 max_attempts, duration_overrides, extra_time_pct, proctoring, break_policy, break_seconds,
                 examiner, created_by)`;
  const PLACEHOLDERS = 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
  const tail = [modules, speakingGrading, writingGrading, openFrom, openUntil, maxAttempts,
    overridesJson, pct, proctoringJson, policy, brk, examinerJson, req.user.id];

  const made = [];
  if (classGroup) {
    made.push(await db.insert(
      `INSERT INTO assignments ${COLS.replace('%TARGET%', 'class_group')} ${PLACEHOLDERS}`,
      [testId, classGroup, ...tail]
    ));
  }
  for (const uid of userIds) {
    made.push(await db.insert(
      `INSERT INTO assignments ${COLS.replace('%TARGET%', 'user_id')} ${PLACEHOLDERS}`,
      [testId, uid, ...tail]
    ));
  }
  await db.exec('UPDATE tests SET published = 1 WHERE id = ?', [testId]);

  // 通知被指派到的學生。通知失敗不能讓指派本身失敗。
  try {
    const t = await db.one('SELECT title FROM tests WHERE id = ?', [testId]);
    let targets = userIds.map(Number).filter(Boolean);
    if (classGroup) {
      const rows = await db.query(
        "SELECT id FROM users WHERE class_group = ? AND role = 'student' AND active = 1", [classGroup]);
      targets = targets.concat(rows.map((r) => r.id));
    }
    if (targets.length) {
      await notify.push(targets, {
        type: 'assignment',
        title: `你有一份新的考試：${t?.title || ''}`,
        body: openUntil ? `請在 ${String(openUntil).slice(0, 16).replace('T', ' ')} 之前完成。` : '可以隨時開始。',
        link: '#/',
      });
    }
  } catch (e) {
    console.warn('[assign] 通知失敗：', e.message);
  }

  res.json({ ids: made });
});

router.delete('/assignments/:id', requireStaff, async (req, res) => {
  const id = Number(req.params.id);
  // 沒有這道檢查的話，非數字的 id 會直接送進 SQL：
  // MySQL 嚴格模式會丟出 Truncated incorrect DOUBLE value，變成看不懂的 500
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '指派編號不正確' });
  const r = await db.exec('DELETE FROM assignments WHERE id = ?', [id]);
  if (!r.affectedRows) return res.status(404).json({ error: '找不到這筆指派' });
  res.json({ ok: true });
});

module.exports = router;
