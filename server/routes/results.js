'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireStaff } = require('../middleware/auth');
const { normalizePaper, flattenQuestions } = require('../lib/paper');
const bands = require('../lib/bands');
const grade = require('../lib/grade');

const router = express.Router();
router.use(requireAuth);

function safeParse(s, fallback = null) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/** 老師：全部成績清單 */
router.get('/', requireStaff, async (req, res) => {
  const { testId, classGroup, status } = req.query;
  const where = [];
  const params = [];
  if (testId) { where.push('a.test_id = ?'); params.push(testId); }
  if (classGroup) { where.push('u.class_group = ?'); params.push(classGroup); }
  if (status) { where.push('a.status = ?'); params.push(status); }
  const rows = await db.query(
    `SELECT a.id, a.status, a.started_at, a.submitted_at, a.modules,
            a.listening_band, a.reading_band, a.writing_band, a.speaking_band, a.overall_band,
            u.id AS user_id, u.name AS student_name, u.username, u.class_group, u.candidate_no,
            t.id AS test_id, t.title AS test_title, t.test_type
     FROM attempts a
     JOIN users u ON u.id = a.user_id
     JOIN tests t ON t.id = a.test_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.submitted_at DESC, a.started_at DESC`,
    params
  );
  res.json({ results: rows });
});

/** 一場考試的完整成績（成績單 + 逐題檢討） */
router.get('/:id', async (req, res) => {
  const attempt = await db.one('SELECT * FROM attempts WHERE id = ?', [req.params.id]);
  if (!attempt) return res.status(404).json({ error: '找不到這場考試' });
  if (attempt.user_id !== req.user.id && req.user.role === 'student')
    return res.status(403).json({ error: '權限不足' });

  const user = await db.one(
    'SELECT id, name, username, candidate_no, class_group, date_of_birth, nationality FROM users WHERE id = ?',
    [attempt.user_id]
  );
  const test = await db.one('SELECT * FROM tests WHERE id = ?', [attempt.test_id]);
  const paper = normalizePaper(JSON.parse(test.content));

  const modRows = await db.query('SELECT * FROM module_results WHERE attempt_id = ?', [attempt.id]);
  const moduleResults = {};
  for (const r of modRows) {
    moduleResults[r.module] = {
      module: r.module,
      rawScore: r.raw_score == null ? null : Number(r.raw_score),
      total: r.total,
      band: r.band == null ? null : Number(r.band),
      criteria: safeParse(r.criteria, null),
      feedback: safeParse(r.feedback, null),
      gradedBy: r.graded_by,
      gradedAt: r.graded_at,
    };
  }

  // 逐題檢討（含正解與解析），只有交卷後才給
  const review = {};
  if (attempt.status !== 'in_progress') {
    for (const mod of ['listening', 'reading']) {
      if (!attempt.modules.includes(mod)) continue;
      const qs = flattenQuestions(paper, mod);
      if (!qs.length) continue;
      const ans = await db.query(
        'SELECT q_number, response, correct FROM answers WHERE attempt_id = ? AND module = ?',
        [attempt.id, mod]
      );
      const map = new Map(ans.map((a) => [Number(a.q_number), a]));
      review[mod] = qs.map((q) => {
        const a = map.get(q.number);
        return {
          number: q.number, type: q.type, section: q.sectionTitle, text: q.text,
          response: a?.response ?? '', correct: a ? !!a.correct : false,
          answers: q.answers, explanation: q.explanation,
          options: q.options || null,
        };
      });
    }
  }

  const writing = await db.query('SELECT * FROM writing_responses WHERE attempt_id = ? ORDER BY task_no', [attempt.id]);
  const speaking = await db.query(
    'SELECT part, q_index, question, transcript, duration_sec, audio_path FROM speaking_responses WHERE attempt_id = ? ORDER BY part, q_index',
    [attempt.id]
  );

  const tasks = grade.writingTasks(paper);

  // 考試紀律事件（只有老師看得到明細，學生只看得到自己有沒有被記點）
  const eventRows = await db.query(
    'SELECT module, type, detail, created_at FROM exam_events WHERE attempt_id = ? ORDER BY id',
    [attempt.id]
  );
  const eventCounts = {};
  for (const e of eventRows) eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
  const conduct = {
    counts: eventCounts,
    leaveCount: (eventCounts.leave || 0) + (eventCounts.fullscreen_exit || 0),
    events: req.user.role === 'student' ? [] : eventRows,
  };

  res.json({
    conduct,
    attempt: {
      id: attempt.id, status: attempt.status, modules: attempt.modules.split(','),
      startedAt: attempt.started_at, submittedAt: attempt.submitted_at, gradedAt: attempt.graded_at,
      bands: {
        listening: attempt.listening_band == null ? null : Number(attempt.listening_band),
        reading: attempt.reading_band == null ? null : Number(attempt.reading_band),
        writing: attempt.writing_band == null ? null : Number(attempt.writing_band),
        speaking: attempt.speaking_band == null ? null : Number(attempt.speaking_band),
        overall: attempt.overall_band == null ? null : Number(attempt.overall_band),
      },
      cefr: bands.cefrLevel(attempt.overall_band == null ? null : Number(attempt.overall_band)),
      bandSummary: bands.bandSummary(attempt.overall_band == null ? null : Number(attempt.overall_band)),
    },
    candidate: user,
    test: { id: test.id, title: test.title, testType: test.test_type },
    moduleResults,
    review,
    writing: writing.map((w) => ({
      taskNo: w.task_no, essay: w.essay, wordCount: w.word_count,
      band: w.band == null ? null : Number(w.band),
      criteria: safeParse(w.criteria, null), feedback: safeParse(w.feedback, null),
      gradedBy: w.graded_by, gradedAt: w.graded_at,
      prompt: tasks.find((t) => t.taskNo === w.task_no)?.prompt || '',
      image: tasks.find((t) => t.taskNo === w.task_no)?.image || null,
      minWords: tasks.find((t) => t.taskNo === w.task_no)?.minWords || 150,
    })),
    speaking,
    criteriaLabels: { writing: bands.WRITING_CRITERIA, speaking: bands.SPEAKING_CRITERIA },
  });
});

/** 老師：手動改分（寫作／口說／任何一科） */
router.post('/:id/grade', requireStaff, async (req, res) => {
  const { module: mod, band, criteria, comment, taskNo } = req.body || {};
  const attempt = await db.one('SELECT id FROM attempts WHERE id = ?', [req.params.id]);
  if (!attempt) return res.status(404).json({ error: '找不到這場考試' });

  if (mod === 'writing' && taskNo) {
    await db.exec(
      `UPDATE writing_responses SET band=?, criteria=?, feedback=?, graded_by=?, graded_at=NOW()
       WHERE attempt_id=? AND task_no=?`,
      [band, JSON.stringify(criteria || {}), JSON.stringify({ summary_zh: comment || '', byTeacher: true }),
       req.user.username, attempt.id, taskNo]
    );
    const rows = await db.query('SELECT task_no, band FROM writing_responses WHERE attempt_id = ?', [attempt.id]);
    let sum = 0, w = 0;
    for (const r of rows) {
      if (r.band == null) continue;
      const ww = Number(r.task_no) === 2 ? 2 : 1;
      sum += Number(r.band) * ww; w += ww;
    }
    const overall = w ? bands.roundHalfBand(sum / w) : null;
    await db.exec(
      `INSERT INTO module_results (attempt_id, module, band, graded_by, graded_at) VALUES (?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE band=VALUES(band), graded_by=VALUES(graded_by), graded_at=NOW()`,
      [attempt.id, 'writing', overall, req.user.username]
    );
  } else {
    const finalBand = band != null ? bands.roundHalfBand(Number(band)) : bands.criteriaToBand(criteria);
    await db.exec(
      `INSERT INTO module_results (attempt_id, module, band, criteria, feedback, graded_by, graded_at)
       VALUES (?,?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE band=VALUES(band), criteria=VALUES(criteria),
         feedback=VALUES(feedback), graded_by=VALUES(graded_by), graded_at=NOW()`,
      [attempt.id, mod, finalBand, JSON.stringify(criteria || {}),
       JSON.stringify({ summary_zh: comment || '', byTeacher: true }), req.user.username]
    );
  }

  const summary = await grade.recomputeAttempt(attempt.id);
  res.json({ ok: true, summary });
});

/** 老師：重新批改（例如改了答案卷之後） */
router.post('/:id/regrade', requireStaff, async (req, res) => {
  try {
    const out = await grade.gradeAttempt(req.params.id, {
      speakingMode: req.body?.speakingMode || 'ai',
      writingMode: req.body?.writingMode || 'ai',
      userId: req.user.id,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 班級統計 */
router.get('/stats/overview', requireStaff, async (req, res) => {
  const byTest = await db.query(
    `SELECT t.id, t.title, COUNT(a.id) AS attempts,
            AVG(a.overall_band) AS avg_overall, AVG(a.listening_band) AS avg_listening,
            AVG(a.reading_band) AS avg_reading, AVG(a.writing_band) AS avg_writing,
            AVG(a.speaking_band) AS avg_speaking
     FROM tests t LEFT JOIN attempts a ON a.test_id = t.id AND a.status = 'graded'
     GROUP BY t.id, t.title ORDER BY t.id DESC`
  );
  const byClass = await db.query(
    `SELECT u.class_group, COUNT(a.id) AS attempts, AVG(a.overall_band) AS avg_overall
     FROM attempts a JOIN users u ON u.id = a.user_id
     WHERE a.status = 'graded' AND u.class_group IS NOT NULL
     GROUP BY u.class_group ORDER BY u.class_group`
  );
  const pending = await db.one(
    "SELECT COUNT(*) AS n FROM attempts WHERE status IN ('submitted','grading')"
  );
  res.json({ byTest, byClass, pending: Number(pending?.n || 0) });
});

module.exports = router;
