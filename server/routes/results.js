'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireStaff } = require('../middleware/auth');
const scope = require('../lib/scope');
const { normalizePaper, flattenQuestions, sectionMedia } = require('../lib/paper');
const bands = require('../lib/bands');
const grade = require('../lib/grade');
const conduct = require('../lib/conduct');

const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
const regradeLimit = rateLimit({ key: 'regrade', by: 'user', windowMs: 60_000, max: 5, message: '重新批改太頻繁' });
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
  const f = await scope.classFilter(req.user, 'u.class_group');
  if (f.sql) { where.push(f.sql.replace(/^ AND /, '').trim()); params.push(...f.params); }
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
  // 班級隔離：受限的老師看不到別班學生的成績、逐字稿與錄音
  if (req.user.role !== 'student' && !(await scope.canSeeAttempt(req.user, attempt.id)))
    return res.status(403).json({ error: '這位學生不在你管理的班級內' });

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
  const reviewMedia = {};
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
          sectionIndex: q.sectionIndex,
          response: a?.response ?? '', correct: a ? !!a.correct : false,
          answers: q.answers, explanation: q.explanation,
          options: q.options || null,
          optionsShared: !!q.optionsShared,
          groupIndex: q.groupIndex,
          // 沒有這些的話，檢討時只看得到一句題幹，
          // 學生根本回想不起來當初在讀什麼、看什麼圖
          instructions: q.instructions || '',
          image: q.image || null,
          bodyHtml: q.bodyHtml || null,
        };
      });
      // 文章／逐字稿一節一份，不要複製到每一題上
      reviewMedia[mod] = sectionMedia(paper, mod);
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
    'SELECT module, type, detail, severity, created_at FROM exam_events WHERE attempt_id = ? ORDER BY id',
    [attempt.id]
  );
  const eventCounts = {};
  const flagged = {};              // 只算需要留意的，給頁面上的數字方塊用
  const bySeverity = { info: 0, warn: 0, alert: 0 };
  for (const e of eventRows) {
    const sev = e.severity || 'warn';
    eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
    if (sev !== 'info') flagged[e.type] = (flagged[e.type] || 0) + 1;
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
  }
  // 只算真的需要留意的。裝置問題造成的離開會標成 info，不要跟切分頁混在一起，
  // 不然老師看到的是一個看不出所以然的數字。
  const realLeaves = eventRows.filter(
    (e) => conduct.LEAVE_TYPES.includes(e.type) && (e.severity || 'warn') !== 'info').length;
  const conductSummary = {
    counts: eventCounts,
    // 頁面標題寫「0 次」、下面的方塊卻紅字寫 1，就是因為兩邊算法不同：
    // 標題排除了 info，方塊沒有。方塊改用這一份。
    flagged,
    bySeverity,
    leaveCount: realLeaves,
    excusedCount: eventRows.filter(
      (e) => conduct.LEAVE_TYPES.includes(e.type) && e.severity === 'info').length,
    events: req.user.role === 'student' ? [] : eventRows,
  };

  res.json({
    conduct: conductSummary,
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
    reviewMedia,
    writing: writing.map((w) => ({
      taskNo: w.task_no, essay: w.essay, wordCount: w.word_count,
      band: w.band == null ? null : Number(w.band),
      criteria: safeParse(w.criteria, null), feedback: safeParse(w.feedback, null),
      gradedBy: w.graded_by, gradedAt: w.graded_at,
      prompt: tasks.find((t) => t.taskNo === w.task_no)?.prompt || '',
      image: tasks.find((t) => t.taskNo === w.task_no)?.image || null,
      // 沒上傳圖檔時，AI 出題當初寫的圖表描述至少讓學生知道在描述什麼
      visualDescription: tasks.find((t) => t.taskNo === w.task_no)?.visualDescription || '',
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
  if (!(await scope.canSeeAttempt(req.user, attempt.id)))
    return res.status(403).json({ error: '這位學生不在你管理的班級內' });

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
router.post('/:id/regrade', regradeLimit, requireStaff, async (req, res) => {
  if (!(await scope.canSeeAttempt(req.user, req.params.id)))
    return res.status(403).json({ error: '這位學生不在你管理的班級內' });
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
  const cf = await scope.classFilter(req.user, 'u.class_group');
  const byClass = await db.query(
    `SELECT u.class_group, COUNT(a.id) AS attempts, AVG(a.overall_band) AS avg_overall
     FROM attempts a JOIN users u ON u.id = a.user_id
     WHERE a.status = 'graded' AND u.class_group IS NOT NULL ${cf.sql}
     GROUP BY u.class_group ORDER BY u.class_group`, cf.params
  );
  const pending = await db.one(
    "SELECT COUNT(*) AS n FROM attempts WHERE status IN ('submitted','grading')"
  );
  res.json({ byTest, byClass, pending: Number(pending?.n || 0) });
});

module.exports = router;
