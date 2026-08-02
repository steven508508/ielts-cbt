'use strict';
/**
 * 考試時限的伺服器端執行。
 *
 * 以前時限完全靠學生的瀏覽器：前端倒數到 0 才呼叫「結束這一科」。
 * 只要那段 JavaScript 沒跑到，時限就等於不存在 ——
 *
 *   · 學生把分頁切到背景（瀏覽器會把計時器節流到一分鐘一次）
 *   · 闔上筆電、當機、關掉分頁
 *   · 網路斷了，收卷的請求送不出去
 *
 * 這幾種情況下那一場考試會永遠停在「考試中」，老師的清單上也一直掛著。
 * 伺服器自己要能收。
 */
const db = require('../db');
const grade = require('./grade');

/** 超過時限多久才真的收掉（跟 exam.js 的 GRACE_SEC 對齊，留給網路延遲） */
const GRACE_SEC = 30;
/** 多久掃一次 */
const SWEEP_MS = 30_000;
/** 一場考試最長掛多久就強制收掉（防止 state 壞掉的紀錄永遠留著） */
const HARD_LIMIT_HOURS = 6;

function parseState(s) {
  try { const v = typeof s === 'string' ? JSON.parse(s) : s; return v && v.modules ? v : { modules: {} }; }
  catch { return { modules: {} }; }
}

/**
 * 掃一次所有還在進行中的考試。
 * @returns {{expired:number, submitted:number}}
 */
async function sweep({ now = Date.now() } = {}) {
  const out = { expired: 0, submitted: 0 };
  let rows;
  try {
    rows = await db.query(
      "SELECT id, user_id, assignment_id, modules, state, started_at FROM attempts WHERE status = 'in_progress'"
    );
  } catch { return out; }

  for (const a of rows) {
    const state = parseState(a.state);
    const chosen = String(a.modules || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!chosen.length) continue;

    let changed = false;
    for (const m of chosen) {
      const st = state.modules[m];
      if (!st || st.finished) continue;
      if (st.endsAt && now > st.endsAt + GRACE_SEC * 1000) {
        state.modules[m] = { ...st, finished: true, finishedAt: st.endsAt, expired: true };
        changed = true;
        out.expired += 1;
      }
    }
    if (changed) {
      try {
        await db.exec('UPDATE attempts SET state = ? WHERE id = ?', [JSON.stringify(state), a.id]);
      } catch { continue; }
    }

    // 每一科都結束了（或時間到了）就整份收卷。
    // 只要還有一科沒開始，就代表學生只是還沒考到，不能替他交。
    const allDone = chosen.every((m) => state.modules[m]?.finished);
    const startedMs = a.started_at ? new Date(String(a.started_at).replace(' ', 'T')).getTime() : 0;
    const tooOld = startedMs && now - startedMs > HARD_LIMIT_HOURS * 3600 * 1000;

    if (allDone || tooOld) {
      try {
        await submitAttempt(a.id, { reason: tooOld && !allDone ? 'hard_limit' : 'time_up' });
        out.submitted += 1;
      } catch (e) {
        console.warn(`[timer] 自動交卷失敗 attempt=${a.id}:`, e.message);
      }
    }
  }
  return out;
}

/**
 * 收卷並開始批改。跟 POST /exam/:id/submit 走同一條路 ——
 * 學生自己按跟系統自動收，結果必須完全一樣。
 */
async function submitAttempt(attemptId, { reason = 'time_up' } = {}) {
  const att = await db.one('SELECT * FROM attempts WHERE id = ?', [attemptId]);
  if (!att || att.status !== 'in_progress') return false;

  const assignment = att.assignment_id
    ? await db.one('SELECT speaking_grading, writing_grading FROM assignments WHERE id = ?', [att.assignment_id])
    : null;

  await db.exec("UPDATE attempts SET status='submitted', submitted_at=NOW() WHERE id=?", [attemptId]);
  await db.exec(
    'INSERT INTO exam_events (attempt_id, module, type, detail, severity) VALUES (?,?,?,?,?)',
    [attemptId, null, 'auto_submit',
      reason === 'hard_limit' ? '超過最長作答時間，系統自動收卷' : '作答時間到，系統自動收卷', 'info']
  );

  grade.gradeAttempt(attemptId, {
    speakingMode: assignment?.speaking_grading || 'ai',
    writingMode: assignment?.writing_grading || 'ai',
    userId: att.user_id,
  }).catch(async (e) => {
    console.warn(`[timer] 批改失敗 attempt=${attemptId}:`, e.message);
    try {
      await db.exec("UPDATE attempts SET status='submitted', grade_error=? WHERE id=?",
        [String(e.message).slice(0, 2000), attemptId]);
    } catch { /* 寫不進去也不能再拋 */ }
  });
  return true;
}

let timer = null;
function start() {
  if (timer) return timer;
  timer = setInterval(() => {
    sweep().then((r) => {
      if (r.expired || r.submitted) {
        console.log(`[timer] 收掉 ${r.expired} 科逾時、自動交卷 ${r.submitted} 場`);
      }
    }).catch((e) => console.warn('[timer] sweep:', e.message));
  }, SWEEP_MS);
  timer.unref?.();
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { sweep, submitAttempt, start, stop, GRACE_SEC, SWEEP_MS, HARD_LIMIT_HOURS };
