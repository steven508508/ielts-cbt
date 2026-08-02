'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { stripAnswers, normalizePaper, countQuestions } = require('../lib/paper');
const { resolveRules } = require('../lib/examRules');
const grade = require('../lib/grade');
const conduct = require('../lib/conduct');

const router = express.Router();
router.use(requireAuth);

const GRACE_SEC = 30;

async function loadAttempt(req, res, next) {
  const attempt = await db.one('SELECT * FROM attempts WHERE id = ?', [req.params.id]);
  if (!attempt) return res.status(404).json({ error: '找不到這場考試' });
  if (attempt.user_id !== req.user.id && req.user.role === 'student')
    return res.status(403).json({ error: '權限不足' });
  req.attempt = attempt;
  req.state = attempt.state ? JSON.parse(attempt.state) : { modules: {} };
  if (!req.state.modules) req.state.modules = {};
  next();
}

async function saveState(attemptId, state) {
  await db.exec('UPDATE attempts SET state = ? WHERE id = ?', [JSON.stringify(state), attemptId]);
}

/** 學生可以考的試卷 */
router.get('/available', async (req, res) => {
  const rows = await db.query(
    `SELECT a.*, t.title, t.test_type, t.description
     FROM assignments a JOIN tests t ON t.id = a.test_id
     WHERE (a.user_id = ? OR (a.class_group IS NOT NULL AND a.class_group = ?))
       AND t.published = 1
     ORDER BY a.created_at DESC`,
    [req.user.id, req.user.class_group || null]
  );

  const attempts = await db.query(
    `SELECT id, test_id, assignment_id, status, started_at, submitted_at, overall_band
     FROM attempts WHERE user_id = ? ORDER BY started_at DESC`,
    [req.user.id]
  );

  const out = rows.map((a) => {
    const mine = attempts.filter((x) => x.test_id === a.test_id);
    const now = Date.now();
    const notYet = a.open_from && new Date(a.open_from).getTime() > now;
    const closed = a.open_until && new Date(a.open_until).getTime() < now;
    return {
      assignmentId: a.id, testId: a.test_id, title: a.title, testType: a.test_type,
      description: a.description, modules: a.modules.split(','),
      speakingGrading: a.speaking_grading, writingGrading: a.writing_grading,
      openFrom: a.open_from, openUntil: a.open_until, maxAttempts: a.max_attempts,
      attempts: mine, canStart: !notYet && !closed && mine.filter((m) => m.status !== 'in_progress').length < a.max_attempts,
      inProgress: mine.find((m) => m.status === 'in_progress') || null,
      blockedReason: notYet ? '尚未開放' : closed ? '已截止' : null,
    };
  });
  res.json({ available: out });
});

/** 我的成績紀錄 */
router.get('/my-attempts', async (req, res) => {
  const rows = await db.query(
    `SELECT a.id, a.test_id, a.status, a.started_at, a.submitted_at, a.modules,
            a.listening_band, a.reading_band, a.writing_band, a.speaking_band, a.overall_band,
            t.title, t.test_type
     FROM attempts a JOIN tests t ON t.id = a.test_id
     WHERE a.user_id = ? ORDER BY a.started_at DESC`,
    [req.user.id]
  );
  res.json({ attempts: rows });
});

/** 開始（或接續）考試 */
router.post('/start', async (req, res) => {
  const { assignmentId, testId, modules } = req.body || {};
  const isStudent = req.user.role === 'student';
  let asg = null;
  if (assignmentId) asg = await db.one('SELECT * FROM assignments WHERE id = ?', [assignmentId]);

  /* ── 授權 ──────────────────────────────────────────────────
     這裡以前完全沒有把關，只要是登入過的學生，直接送一個 testId
     就能開任何一份試卷 —— 包含還沒發布的下週考卷。開完立刻交卷，
     再打 /results/:id 就拿得到整份標準答案與解析（review 只看
     status 不是 in_progress）。三個請求就能把答案卷撈光。

     所以：學生一定要有一張指派給「他自己或他的班級」的指派單；
     老師與管理員才可以用 testId 直接試考。 */
  if (asg) {
    const mine = asg.user_id === req.user.id
      || (asg.class_group && asg.class_group === req.user.class_group);
    if (isStudent && !mine) return res.status(403).json({ error: '這份考試沒有指派給你' });
  } else if (isStudent) {
    return res.status(403).json({ error: '這份考試沒有指派給你' });
  }

  const tid = asg ? asg.test_id : testId;
  if (!tid) return res.status(400).json({ error: '缺少試卷' });
  const test = await db.one('SELECT * FROM tests WHERE id = ?', [tid]);
  if (!test) return res.status(404).json({ error: '找不到試卷' });

  // 開放時間也要由伺服器把關，不能只靠前端把按鈕變灰
  if (isStudent && asg) {
    const now = Date.now();
    if (asg.open_from && now < new Date(String(asg.open_from).replace(' ', 'T')).getTime()) {
      return res.status(403).json({ error: '這份考試還沒開放' });
    }
    if (asg.open_until && now > new Date(String(asg.open_until).replace(' ', 'T')).getTime()) {
      return res.status(403).json({ error: '這份考試已經截止' });
    }
  }

  const existing = await db.one(
    "SELECT * FROM attempts WHERE user_id = ? AND test_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1",
    [req.user.id, tid]
  );
  if (existing) return res.json({ attemptId: existing.id, resumed: true });

  if (asg) {
    const done = await db.one(
      "SELECT COUNT(*) AS n FROM attempts WHERE user_id = ? AND test_id = ? AND status <> 'in_progress'",
      [req.user.id, tid]
    );
    if (Number(done.n) >= Number(asg.max_attempts))
      return res.status(403).json({ error: `這份試卷最多只能考 ${asg.max_attempts} 次` });
  }

  const paper = normalizePaper(JSON.parse(test.content));
  const available = paper.modules.map((m) => m.module);
  let chosen = (asg ? asg.modules.split(',') : (modules || available)).map((s) => s.trim()).filter(Boolean);
  chosen = chosen.filter((m) => available.includes(m));
  if (!chosen.length) return res.status(400).json({ error: '這份試卷沒有可考的科目' });

  const id = await db.insert(
    'INSERT INTO attempts (test_id, user_id, assignment_id, modules, state) VALUES (?,?,?,?,?)',
    [tid, req.user.id, asg ? asg.id : null, chosen.join(','), JSON.stringify({ modules: {} })]
  );
  res.json({ attemptId: id, resumed: false });
});

/** 取得考卷（已移除答案） */
router.get('/:id', loadAttempt, async (req, res) => {
  const test = await db.one('SELECT * FROM tests WHERE id = ?', [req.attempt.test_id]);
  const full = normalizePaper(JSON.parse(test.content));
  const chosen = req.attempt.modules.split(',');

  const safe = stripAnswers(full);
  safe.modules = safe.modules.filter((m) => chosen.includes(m.module));
  // 考試中不給逐字稿
  for (const m of safe.modules) for (const s of m.sections || []) delete s.transcript;

  const rows = await db.query('SELECT module, q_number, response, flagged FROM answers WHERE attempt_id = ?', [req.attempt.id]);
  const writing = await db.query('SELECT task_no, essay, word_count FROM writing_responses WHERE attempt_id = ?', [req.attempt.id]);
  const speaking = await db.query('SELECT part, q_index, question, transcript, duration_sec, audio_path FROM speaking_responses WHERE attempt_id = ?', [req.attempt.id]);

  const assignment = req.attempt.assignment_id
    ? await db.one('SELECT * FROM assignments WHERE id = ?', [req.attempt.assignment_id])
    : null;
  const rules = resolveRules(assignment, full, chosen);

  // 條件一定要跟回報事件時算的一模一樣，否則學生一重新整理，
  // 被判定「不算違規」的那幾次又冒出來，次數平白跳上去。
  const leaves = await db.one(
    `SELECT COUNT(*) AS n FROM exam_events WHERE attempt_id = ? AND ${conduct.LEAVE_WHERE}`,
    [req.attempt.id]
  );

  res.json({
    attempt: {
      id: req.attempt.id, testId: req.attempt.test_id, status: req.attempt.status,
      modules: chosen, startedAt: req.attempt.started_at,
      speakingGrading: assignment?.speaking_grading || 'ai',
      writingGrading: assignment?.writing_grading || 'ai',
    },
    rules,
    leaveCount: Number(leaves?.n || 0),
    paper: safe,
    state: req.state,
    saved: {
      answers: rows, writing, speaking,
    },
    counts: { listening: countQuestions(full, 'listening'), reading: countQuestions(full, 'reading') },
    serverTime: Date.now(),
  });
});

/** 開始某一科，伺服器記錄結束時間 */
router.post('/:id/module/start', loadAttempt, async (req, res) => {
  const { module: mod } = req.body || {};
  if (!req.attempt.modules.split(',').includes(mod)) return res.status(400).json({ error: '這場考試沒有這一科' });
  if (req.attempt.status !== 'in_progress') return res.status(409).json({ error: '這場考試已經結束' });

  const test = await db.one('SELECT content FROM tests WHERE id = ?', [req.attempt.test_id]);
  const paper = normalizePaper(JSON.parse(test.content));
  const assignment = req.attempt.assignment_id
    ? await db.one('SELECT * FROM assignments WHERE id = ?', [req.attempt.assignment_id])
    : null;
  // 時間以「老師指派時的設定」為準：每科覆寫 + 額外時間百分比
  const rules = resolveRules(assignment, paper, req.attempt.modules.split(','));
  const duration = rules.durations[mod] || 1800;

  const st = req.state.modules[mod];
  // 已經交卷的科目不能再進來。以前這裡只看有沒有 endsAt，於是超過離開上限
  // 被自動收卷之後，重新整理一下又能回到作答畫面，打什麼都被默默退掉。
  if (st && st.finished) {
    return res.status(409).json({
      error: st.autoSubmitted
        ? '這一科因為離開考試畫面次數超過上限，已經自動收卷'
        : '這一科已經交卷',
      finished: true, autoSubmitted: !!st.autoSubmitted,
    });
  }
  if (st && st.endsAt) {
    return res.json({
      startedAt: st.startedAt, endsAt: st.endsAt, serverTime: Date.now(),
      resumed: true, durationSec: st.durationSec || duration, breakdown: rules.breakdown[mod],
    });
  }
  const startedAt = Date.now();
  const endsAt = startedAt + duration * 1000;
  req.state.modules[mod] = { startedAt, endsAt, durationSec: duration };
  await db.exec('UPDATE attempts SET state = ?, current_module = ? WHERE id = ?', [JSON.stringify(req.state), mod, req.attempt.id]);
  // severity 一定要明寫。這個欄位的預設值是 'warn'，不寫的話
  // 「開始作答」這種純紀錄也會被算進老師看到的「需留意」件數裡。
  await db.exec(
    'INSERT INTO exam_events (attempt_id, module, type, detail, severity) VALUES (?,?,?,?,?)',
    [req.attempt.id, mod, 'module_start', `時限 ${Math.round(duration / 60)} 分鐘`, 'info']);
  res.json({
    startedAt, endsAt, serverTime: Date.now(), resumed: false,
    durationSec: duration, breakdown: rules.breakdown[mod],
  });
});

/**
 * 對時。
 *
 * 前端的倒數以前是用 `endsAt - Date.now()` 算的 —— endsAt 是伺服器的時鐘，
 * Date.now() 是學生自己電腦的時鐘。學生的電腦慢十分鐘就多考十分鐘，
 * 快十分鐘則一進去就被判定時間到。而且分頁切到背景時瀏覽器會把計時器
 * 節流成一分鐘一次，回來之後顯示會補正，但「時間到該收卷」那一刻可能整個被跳過。
 * 所以前端要定期跟伺服器對時，並以伺服器算出來的剩餘秒數為準。
 */
router.get('/:id/time', loadAttempt, async (req, res) => {
  const now = Date.now();
  const mods = {};
  for (const m of req.attempt.modules.split(',')) {
    const st = req.state.modules[m];
    if (!st) { mods[m] = { started: false }; continue; }
    mods[m] = {
      started: true,
      finished: !!st.finished,
      expired: !!st.expired,
      endsAt: st.endsAt || null,
      remainingSec: st.endsAt ? Math.max(0, Math.round((st.endsAt - now) / 1000)) : null,
    };
  }
  res.json({ serverTime: now, status: req.attempt.status, modules: mods });
});

// ── 考試紀律事件 ───────────────────────────────────────────────
const EVENT_TYPES = ['leave', 'return', 'fullscreen_exit', 'fullscreen_enter', 'copy_blocked',
  'paste_blocked', 'resize', 'devtools', 'auto_submit', 'device_permission', 'device_check'];

/** 前端回報一個事件；回傳目前累計次數，讓前端知道要不要處置 */
router.post('/:id/event', loadAttempt, async (req, res) => {
  const { type, module: mod, detail } = req.body || {};
  if (!EVENT_TYPES.includes(type)) return res.status(400).json({ error: '未知的事件類型' });
  if (req.attempt.status !== 'in_progress') return res.json({ ok: true, ignored: true });

  const module = mod || req.attempt.current_module || null;

  // 等級由伺服器判，不看前端送什麼 —— 不然「這次不算違規」就變成前端說了算。
  const last = await db.one(
    `SELECT created_at FROM exam_events
      WHERE attempt_id = ? AND type = 'device_permission'
      ORDER BY id DESC LIMIT 1`, [req.attempt.id]
  );
  const msSinceDeviceIssue = last?.created_at
    ? Date.now() - new Date(String(last.created_at).replace(' ', 'T')).getTime()
    : null;
  const { severity, reason } = conduct.classify(type, { module, msSinceDeviceIssue });
  const note = reason ? `${String(detail || '')}（${reason}）` : String(detail || '');

  await db.exec(
    'INSERT INTO exam_events (attempt_id, module, type, detail, severity) VALUES (?,?,?,?,?)',
    [req.attempt.id, module, type, note.slice(0, 250), severity]
  );

  // 只有 warn 以上才算「離開」。裝置問題造成的離開不該把學生推向自動收卷。
  const row = await db.one(
    `SELECT COUNT(*) AS n FROM exam_events WHERE attempt_id = ? AND ${conduct.LEAVE_WHERE}`,
    [req.attempt.id]
  );
  const leaveCount = Number(row?.n || 0);

  // 上限的處置由伺服器決定並執行。以前整段判斷只寫在前端，
  // 學生只要不讓那段 JavaScript 跑完，超過幾次都不會被收卷 ——
  // 那樣的「上限」等於沒有。
  const assignment = req.attempt.assignment_id
    ? await db.one('SELECT * FROM assignments WHERE id = ?', [req.attempt.assignment_id])
    : null;
  const test = await db.one('SELECT content FROM tests WHERE id = ?', [req.attempt.test_id]);
  const rules = resolveRules(assignment, normalizePaper(JSON.parse(test.content)),
    req.attempt.modules.split(','));
  const p = rules.proctoring || {};
  let autoSubmitted = false;
  if (p.enabled && p.onExceed === 'submit' && conduct.exceedsLimit(leaveCount, p.maxLeaves)
      && module && !req.state.modules?.[module]?.finished) {
    req.state.modules[module] = {
      ...(req.state.modules[module] || {}), finished: true, finishedAt: Date.now(),
      autoSubmitted: true,
    };
    await db.exec('UPDATE attempts SET state = ? WHERE id = ?',
      [JSON.stringify(req.state), req.attempt.id]);
    await db.exec(
      'INSERT INTO exam_events (attempt_id, module, type, detail, severity) VALUES (?,?,?,?,?)',
      [req.attempt.id, module, 'auto_submit',
        `離開 ${leaveCount} 次，超過上限 ${p.maxLeaves} 次`, 'alert']);
    autoSubmitted = true;
  }

  res.json({
    ok: true, severity, excused: severity === 'info', reason, leaveCount,
    maxLeaves: p.maxLeaves || 0,
    remaining: p.maxLeaves > 0 ? conduct.remainingLeaves(leaveCount, p.maxLeaves) : null,
    autoSubmitted,
  });
});

/** 老師查看某場考試的紀律事件 */
router.get('/:id/events', loadAttempt, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ error: '權限不足' });
  const rows = await db.query(
    'SELECT module, type, detail, severity, created_at FROM exam_events WHERE attempt_id = ? ORDER BY id',
    [req.attempt.id]
  );
  const counts = {};
  for (const r of rows) counts[r.type] = (counts[r.type] || 0) + 1;
  res.json({ events: rows, counts });
});

/** 標記某一科已結束（不能再作答） */
router.post('/:id/module/finish', loadAttempt, async (req, res) => {
  const { module: mod } = req.body || {};
  req.state.modules[mod] = { ...(req.state.modules[mod] || {}), finished: true, finishedAt: Date.now() };
  await saveState(req.attempt.id, req.state);
  res.json({ ok: true });
});

/**
 * 這一科現在能不能作答。
 *
 * 以前「還沒 module/start」直接回 ok —— 於是學生只要跳過 /module/start，
 * 伺服器就從來沒記過 endsAt，那一科等於沒有時限，想寫多久寫多久。
 * 時間管制是考試公平的核心，不能靠前端有沒有乖乖呼叫。
 */
function moduleOpen(state, mod, { strict = true } = {}) {
  const st = state.modules[mod];
  if (!st) return strict ? { ok: false, error: `請先開始「${mod}」這一科` } : { ok: true };
  if (st.finished) return { ok: false, error: `${mod} 已經交卷` };
  if (st.endsAt && Date.now() > st.endsAt + GRACE_SEC * 1000) {
    // 順手收掉，不要等 30 秒的掃描 —— 也讓 expired 這個標記立刻成立
    st.finished = true;
    st.finishedAt = st.endsAt;
    st.expired = true;
    return { ok: false, error: `${mod} 作答時間已結束`, justExpired: true };
  }
  return { ok: true };
}

/** 自動儲存作答（可一次送多題） */
router.post('/:id/answers', loadAttempt, async (req, res) => {
  if (req.attempt.status !== 'in_progress') return res.status(409).json({ error: '這場考試已經交卷' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
  const rejected = [];
  for (const it of items) {
    const mod = String(it.module || '');
    const gate = moduleOpen(req.state, mod);
    if (!gate.ok) { rejected.push({ ...it, reason: gate.error }); continue; }
    await db.exec(
      `INSERT INTO answers (attempt_id, module, q_number, response, flagged)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE response = VALUES(response), flagged = VALUES(flagged)`,
      [req.attempt.id, mod, Number(it.number), it.response == null ? '' : String(it.response), it.flagged ? 1 : 0]
    );
  }
  res.json({ ok: true, saved: items.length - rejected.length, rejected });
});

/** 儲存寫作 */
router.post('/:id/writing', loadAttempt, async (req, res) => {
  if (req.attempt.status !== 'in_progress') return res.status(409).json({ error: '這場考試已經交卷' });
  const gate = moduleOpen(req.state, 'writing');
  if (!gate.ok) return res.status(409).json({ error: gate.error });
  const { taskNo, essay } = req.body || {};
  const words = String(essay || '').trim().split(/\s+/).filter(Boolean).length;
  await db.exec(
    `INSERT INTO writing_responses (attempt_id, task_no, essay, word_count)
     VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE essay = VALUES(essay), word_count = VALUES(word_count)`,
    [req.attempt.id, Number(taskNo), String(essay || ''), words]
  );
  res.json({ ok: true, wordCount: words });
});

/** 儲存前端狀態（目前題號、捲動位置、註記…） */
router.post('/:id/state', loadAttempt, async (req, res) => {
  req.state.ui = req.body?.ui ?? req.state.ui;
  await saveState(req.attempt.id, req.state);
  res.json({ ok: true });
});

/** 交卷 + 批改 */
router.post('/:id/submit', loadAttempt, async (req, res) => {
  if (req.attempt.status !== 'in_progress') {
    return res.json({ ok: true, alreadySubmitted: true, attemptId: req.attempt.id });
  }
  const assignment = req.attempt.assignment_id
    ? await db.one('SELECT speaking_grading, writing_grading FROM assignments WHERE id = ?', [req.attempt.assignment_id])
    : null;

  await db.exec("UPDATE attempts SET status='submitted', submitted_at=NOW() WHERE id=?", [req.attempt.id]);

  // 先回應，批改在背景進行（AI 批改可能要幾十秒）
  res.json({ ok: true, attemptId: req.attempt.id, grading: true });

  grade
    .gradeAttempt(req.attempt.id, {
      speakingMode: assignment?.speaking_grading || 'ai',
      writingMode: assignment?.writing_grading || 'ai',
      userId: req.user.id,
    })
    .catch(async (e) => {
      // 千萬不能寫回 'grading' —— 那是「正在批改」的狀態，寫下去這場考試
      // 就永遠停在轉圈，沒有任何機制會再回來處理它。
      // 退回 'submitted' 才是可重試的狀態，重啟時的 reaper 會撿回去。
      console.error('[grade] 批改失敗，退回 submitted 等待重試：', e.message);
      await db.exec(
        "UPDATE attempts SET status='submitted', grade_error=? WHERE id=?",
        [String(e.message || '').slice(0, 500), req.attempt.id]
      ).catch(() => {});
    });
});

/** 查詢批改進度 */
router.get('/:id/status', loadAttempt, async (req, res) => {
  const a = await db.one(
    'SELECT status, listening_band, reading_band, writing_band, speaking_band, overall_band FROM attempts WHERE id = ?',
    [req.attempt.id]
  );
  const mods = await db.query('SELECT module, band, graded_by FROM module_results WHERE attempt_id = ?', [req.attempt.id]);
  res.json({ ...a, modules: mods });
});

module.exports = router;
