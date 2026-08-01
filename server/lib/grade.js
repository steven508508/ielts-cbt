'use strict';
/** 批改流程：聽力／閱讀自動批改、寫作／口說 AI 評分、換算 band 與總分。 */
const db = require('../db');
const { flattenQuestions } = require('./paper');
const { checkAnswer } = require('./answers');
const bands = require('./bands');
const aiTasks = require('./aiTasks');

async function markingOptions() {
  const s = await db.getSettings();
  return {
    allowSpellingVariants: s.allowSpellingVariants !== false,
    hyphenEqualsSpace: s.hyphenEqualsSpace !== false,
    expandContractions: s.expandContractions !== false,
    tables: s.bandTables || bands.DEFAULT_TABLES,
  };
}

/** 批改單一科的客觀題，寫回 answers 表並回傳明細 */
async function gradeObjectiveModule(attemptId, paper, moduleName) {
  const opts = await markingOptions();
  const questions = flattenQuestions(paper, moduleName);
  if (!questions.length) return null;

  const rows = await db.query(
    'SELECT q_number, response FROM answers WHERE attempt_id = ? AND module = ?',
    [attemptId, moduleName]
  );
  const responses = new Map(rows.map((r) => [Number(r.q_number), r.response]));

  // mcq_multi：整組共用一個作答字串，分數平均分配到組內各題號
  const multiGroups = new Map();
  for (const q of questions) {
    if (q.type !== 'mcq_multi') continue;
    const key = `${q.sectionIndex}-${q.groupIndex}`;
    if (!multiGroups.has(key)) multiGroups.set(key, []);
    multiGroups.get(key).push(q);
  }
  const multiResult = new Map();
  for (const [key, group] of multiGroups) {
    const numbers = group.map((g) => g.number);
    const raw = numbers.map((n) => responses.get(n)).find((v) => v != null && String(v).trim() !== '') || '';
    const res = checkAnswer(group[0], raw, opts);
    multiResult.set(key, { res, numbers, raw });
  }

  const detail = [];
  let rawScore = 0;

  for (const q of questions) {
    let correct = false;
    let awarded = 0;
    let reason = '';
    const response = responses.get(q.number) ?? '';

    if (q.type === 'mcq_multi') {
      const key = `${q.sectionIndex}-${q.groupIndex}`;
      const m = multiResult.get(key);
      const idx = m.numbers.indexOf(q.number);
      // 把答對的個數平均分配給組內題號（每題 0 或 1 分）
      awarded = idx < m.res.awarded ? 1 : 0;
      correct = awarded === 1;
      reason = m.res.reason || '';
    } else {
      const r = checkAnswer(q, response, opts);
      correct = r.correct;
      awarded = r.awarded;
      reason = r.reason || '';
    }

    rawScore += awarded;
    detail.push({
      number: q.number,
      type: q.type,
      section: q.sectionTitle,
      response: String(response ?? ''),
      expected: q.answers,
      correct,
      reason,
      explanation: q.explanation || '',
    });

    await db.exec(
      `INSERT INTO answers (attempt_id, module, q_number, response, correct, expected)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE correct = VALUES(correct), expected = VALUES(expected)`,
      [attemptId, moduleName, q.number, String(response ?? ''), correct ? 1 : 0, JSON.stringify(q.answers)]
    );
  }

  const total = questions.length;
  const band = bands.rawToBand(rawScore, total, moduleName, paper.testType, opts.tables);

  await db.exec(
    `INSERT INTO module_results (attempt_id, module, raw_score, total, band, feedback, graded_by, graded_at)
     VALUES (?,?,?,?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE raw_score=VALUES(raw_score), total=VALUES(total), band=VALUES(band),
       feedback=VALUES(feedback), graded_by=VALUES(graded_by), graded_at=NOW()`,
    [attemptId, moduleName, rawScore, total, band, JSON.stringify({ detail }), 'auto']
  );

  return { module: moduleName, rawScore, total, band, detail };
}

/** 找出試卷中的寫作題目 */
function writingTasks(paper) {
  const mod = (paper.modules || []).find((m) => m.module === 'writing');
  if (!mod) return [];
  const out = [];
  for (const sec of mod.sections || []) {
    for (const g of sec.groups || []) {
      if (g.type !== 'writing_task') continue;
      for (const q of g.questions || []) {
        out.push({
          taskNo: q.taskNo || q.number || out.length + 1,
          prompt: q.prompt || q.text || '',
          image: q.image || g.image || null,
          visualDescription: q.visualDescription || '',
          minWords: q.minWords || (q.taskNo === 2 ? 250 : 150),
          durationSec: q.durationSec || (q.taskNo === 2 ? 2400 : 1200),
          sampleAnswer: q.sampleAnswer || '',
        });
      }
    }
  }
  return out.sort((a, b) => a.taskNo - b.taskNo);
}

/** 寫作：AI 批改兩篇並依 1:2 加權 */
async function gradeWritingModule(attemptId, paper, userId) {
  const tasks = writingTasks(paper);
  if (!tasks.length) return null;

  const rows = await db.query('SELECT * FROM writing_responses WHERE attempt_id = ?', [attemptId]);
  const byTask = new Map(rows.map((r) => [Number(r.task_no), r]));

  const results = [];
  for (const t of tasks) {
    const row = byTask.get(t.taskNo);
    const essay = row?.essay || '';
    if (!essay.trim()) {
      await db.exec(
        `INSERT INTO writing_responses (attempt_id, task_no, essay, word_count, band, criteria, feedback, graded_by, graded_at)
         VALUES (?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE band=VALUES(band), criteria=VALUES(criteria), feedback=VALUES(feedback),
           graded_by=VALUES(graded_by), graded_at=NOW()`,
        [attemptId, t.taskNo, '', 0, 0, JSON.stringify({ TA: 0, CC: 0, LR: 0, GRA: 0 }),
         JSON.stringify({ summary_zh: '未作答。' }), 'auto']
      );
      results.push({ taskNo: t.taskNo, band: 0, criteria: { TA: 0, CC: 0, LR: 0, GRA: 0 }, feedback: { summary_zh: '未作答。' } });
      continue;
    }

    const graded = await aiTasks.gradeWriting({
      taskNo: t.taskNo, prompt: t.prompt, essay,
      visualDescription: t.visualDescription,
      testType: paper.testType, minWords: t.minWords, userId,
    });
    const band = graded.band != null ? bands.roundHalfBand(Number(graded.band)) : bands.criteriaToBand(graded.criteria);

    await db.exec(
      `UPDATE writing_responses SET band=?, criteria=?, feedback=?, graded_by='ai', graded_at=NOW()
       WHERE attempt_id=? AND task_no=?`,
      [band, JSON.stringify(graded.criteria || {}), JSON.stringify(graded), attemptId, t.taskNo]
    );
    results.push({ taskNo: t.taskNo, band, criteria: graded.criteria, feedback: graded });
  }

  // Task 2 權重是 Task 1 的兩倍
  let weighted = 0, weight = 0;
  for (const r of results) {
    const w = r.taskNo === 2 ? 2 : 1;
    if (r.band == null) continue;
    weighted += r.band * w;
    weight += w;
  }
  const band = weight ? bands.roundHalfBand(weighted / weight) : null;

  const criteria = {};
  for (const k of ['TA', 'CC', 'LR', 'GRA']) {
    let sum = 0, w = 0;
    for (const r of results) {
      const v = Number(r.criteria?.[k]);
      if (Number.isNaN(v)) continue;
      const ww = r.taskNo === 2 ? 2 : 1;
      sum += v * ww; w += ww;
    }
    if (w) criteria[k] = Math.round((sum / w) * 10) / 10;
  }

  await db.exec(
    `INSERT INTO module_results (attempt_id, module, raw_score, total, band, criteria, feedback, graded_by, graded_at)
     VALUES (?,?,?,?,?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE band=VALUES(band), criteria=VALUES(criteria), feedback=VALUES(feedback),
       graded_by=VALUES(graded_by), graded_at=NOW()`,
    [attemptId, 'writing', null, tasks.length, band, JSON.stringify(criteria), JSON.stringify({ tasks: results }), 'ai']
  );

  return { module: 'writing', band, criteria, tasks: results };
}

/** 口說：AI 評分（人工模式則只標記待評） */
async function gradeSpeakingModule(attemptId, mode = 'ai', userId) {
  const responses = await db.query(
    'SELECT part, q_index, question, transcript, duration_sec FROM speaking_responses WHERE attempt_id = ? ORDER BY part, q_index',
    [attemptId]
  );
  if (!responses.length) return null;

  if (mode !== 'ai') {
    await db.exec(
      `INSERT INTO module_results (attempt_id, module, band, feedback, graded_by)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE feedback=VALUES(feedback), graded_by=VALUES(graded_by)`,
      [attemptId, 'speaking', null, JSON.stringify({ pending: true, note: '等待老師人工評分' }), 'pending']
    );
    return { module: 'speaking', band: null, pending: true };
  }

  const graded = await aiTasks.gradeSpeaking({ responses, userId });
  const band = graded.band != null ? bands.roundHalfBand(Number(graded.band)) : bands.criteriaToBand(graded.criteria);

  await db.exec(
    `INSERT INTO module_results (attempt_id, module, band, criteria, feedback, graded_by, graded_at)
     VALUES (?,?,?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE band=VALUES(band), criteria=VALUES(criteria), feedback=VALUES(feedback),
       graded_by=VALUES(graded_by), graded_at=NOW()`,
    [attemptId, 'speaking', band, JSON.stringify(graded.criteria || {}), JSON.stringify(graded), 'ai']
  );
  return { module: 'speaking', band, criteria: graded.criteria, feedback: graded };
}

/** 依 module_results 重新計算 attempt 的四科分數與總分 */
async function recomputeAttempt(attemptId) {
  const rows = await db.query('SELECT module, band FROM module_results WHERE attempt_id = ?', [attemptId]);
  const byModule = Object.fromEntries(rows.map((r) => [r.module, r.band == null ? null : Number(r.band)]));
  const overall = bands.overallBand(byModule);
  const pending = await db.one(
    "SELECT COUNT(*) AS n FROM module_results WHERE attempt_id = ? AND (graded_by = 'pending' OR band IS NULL)",
    [attemptId]
  );
  const status = Number(pending?.n || 0) > 0 ? 'grading' : 'graded';

  await db.exec(
    `UPDATE attempts SET listening_band=?, reading_band=?, writing_band=?, speaking_band=?,
       overall_band=?, status=?, graded_at=NOW() WHERE id=?`,
    [byModule.listening ?? null, byModule.reading ?? null, byModule.writing ?? null,
     byModule.speaking ?? null, overall, status, attemptId]
  );
  return { ...byModule, overall, status };
}

/** 完整批改一場考試 */
async function gradeAttempt(attemptId, { speakingMode = 'ai', writingMode = 'ai', userId = null } = {}) {
  const attempt = await db.one('SELECT * FROM attempts WHERE id = ?', [attemptId]);
  if (!attempt) throw new Error('找不到這場考試');
  const test = await db.one('SELECT * FROM tests WHERE id = ?', [attempt.test_id]);
  const paper = JSON.parse(test.content);
  const modules = String(attempt.modules || '').split(',').map((s) => s.trim()).filter(Boolean);

  await db.exec("UPDATE attempts SET status='grading' WHERE id=?", [attemptId]);
  const out = { errors: [] };

  for (const m of ['listening', 'reading']) {
    if (!modules.includes(m)) continue;
    try { out[m] = await gradeObjectiveModule(attemptId, paper, m); }
    catch (e) { out.errors.push(`${m}: ${e.message}`); }
  }

  if (modules.includes('writing')) {
    if (writingMode === 'ai') {
      try { out.writing = await gradeWritingModule(attemptId, paper, userId); }
      catch (e) {
        out.errors.push(`writing: ${e.message}`);
        await db.exec(
          `INSERT INTO module_results (attempt_id, module, band, feedback, graded_by) VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE feedback=VALUES(feedback), graded_by=VALUES(graded_by)`,
          [attemptId, 'writing', null, JSON.stringify({ pending: true, error: e.message }), 'pending']
        );
      }
    } else {
      await db.exec(
        `INSERT INTO module_results (attempt_id, module, band, feedback, graded_by) VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE feedback=VALUES(feedback), graded_by=VALUES(graded_by)`,
        [attemptId, 'writing', null, JSON.stringify({ pending: true, note: '等待老師人工評分' }), 'pending']
      );
    }
  }

  if (modules.includes('speaking')) {
    try { out.speaking = await gradeSpeakingModule(attemptId, speakingMode, userId); }
    catch (e) {
      out.errors.push(`speaking: ${e.message}`);
      await db.exec(
        `INSERT INTO module_results (attempt_id, module, band, feedback, graded_by) VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE feedback=VALUES(feedback), graded_by=VALUES(graded_by)`,
        [attemptId, 'speaking', null, JSON.stringify({ pending: true, error: e.message }), 'pending']
      );
    }
  }

  out.summary = await recomputeAttempt(attemptId);
  return out;
}

/**
 * 撿回卡住的批改。
 *
 * 兩種情況會卡住：
 *   ① 批改到一半伺服器重啟 → 場次永遠停在 'grading'
 *   ② AI 暫時出錯 → 退回 'submitted' 但沒有人會再處理
 * 兩種都會讓學生的成績頁一直轉圈。這裡在開機時與之後每 5 分鐘掃一次。
 */
let sweeping = false;
async function requeueStuck({ olderThanMin = 3, limit = 20 } = {}) {
  if (sweeping) return { picked: 0 };
  sweeping = true;
  try {
    // 重啟後還掛著 'grading' 的其實早就沒有在跑了
    await db.exec(
      "UPDATE attempts SET status='submitted' WHERE status='grading' AND updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)",
      [olderThanMin]
    ).catch(() => {});

    const rows = await db.query(
      `SELECT a.id, a.assignment_id FROM attempts a
        WHERE a.status = 'submitted'
          AND a.submitted_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
        ORDER BY a.submitted_at ASC LIMIT ?`,
      [olderThanMin, Math.min(50, limit)]
    );
    if (!rows.length) return { picked: 0 };

    console.log(`[grade] 撿回 ${rows.length} 場卡住的批改`);
    for (const r of rows) {
      const asg = r.assignment_id
        ? await db.one('SELECT speaking_grading, writing_grading FROM assignments WHERE id = ?', [r.assignment_id])
        : null;
      try {
        await gradeAttempt(r.id, {
          speakingMode: asg?.speaking_grading || 'ai',
          writingMode: asg?.writing_grading || 'ai',
        });
        await db.exec('UPDATE attempts SET grade_error = NULL WHERE id = ?', [r.id]).catch(() => {});
      } catch (e) {
        console.warn(`[grade] 場次 ${r.id} 重試仍然失敗：`, e.message);
        await db.exec(
          "UPDATE attempts SET status='submitted', grade_error=? WHERE id=?",
          [String(e.message || '').slice(0, 500), r.id]
        ).catch(() => {});
      }
    }
    return { picked: rows.length };
  } finally {
    sweeping = false;
  }
}

let sweepTimer = null;
function scheduleSweep() {
  clearInterval(sweepTimer);
  sweepTimer = setInterval(() => { requeueStuck().catch((e) => console.warn('[grade] 掃描失敗：', e.message)); }, 5 * 60_000);
  sweepTimer.unref?.();
  setTimeout(() => { requeueStuck().catch(() => {}); }, 20_000).unref?.();
  return sweepTimer;
}
function stopSweep() { clearInterval(sweepTimer); sweepTimer = null; }

module.exports = {
  gradeAttempt, gradeObjectiveModule, gradeWritingModule, gradeSpeakingModule,
  recomputeAttempt, writingTasks, requeueStuck, scheduleSweep, stopSweep,
};
