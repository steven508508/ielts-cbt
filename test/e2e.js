'use strict';
/**
 * 端對端測試：實際打 HTTP API 跑完一整場考試。
 * 用法：先 `npm start`，再 `node test/e2e.js`
 */
const BASE = process.env.BASE || 'http://localhost:3000';
const { flattenQuestions, normalizePaper } = require('../server/lib/paper');

let pass = 0, fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); }
}

/** 單一請求的上限。卡住的時候要馬上講是哪一支 API，不要等到 undici 五分鐘後才報一句 fetch failed */
const CALL_TIMEOUT = Number(process.env.CALL_TIMEOUT || 45000);

async function call(method, path, body, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT);
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === 'AbortError' || /aborted/i.test(e?.message || '')) {
      return { status: 0, timedOut: true, data: { error: `${method} ${path} 超過 ${CALL_TIMEOUT / 1000} 秒沒有回應` } };
    }
    throw e;
  }
  clearTimeout(timer);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { text }; }
  return { status: res.status, data };
}

(async () => {
  console.log(`\n端對端測試 → ${BASE}\n`);

  console.log('健康檢查');
  const health = await call('GET', '/health');
  ok(health.data.ok === true, '伺服器與資料庫連線正常');
  if (!health.data.ok) process.exit(1);

  console.log('\n登入');
  const bad = await call('POST', '/auth/login', { username: 'student1', password: 'wrong' });
  ok(bad.status === 401, '錯誤密碼被拒絕');

  const login = await call('POST', '/auth/login', { username: 'student1', password: 'ielts1234' });
  ok(login.status === 200 && !!login.data.token, '學生登入成功');
  const stu = login.data.token;

  const teacherLogin = await call('POST', '/auth/login', { username: 'teacher1', password: 'teach1234' });
  const tea = teacherLogin.data.token;
  ok(!!tea, '老師登入成功');

  const adminLogin = await call('POST', '/auth/login', { username: 'admin', password: 'admin1234' });
  const adm = adminLogin.data.token;
  ok(!!adm, '管理員登入成功');

  // 清掉上一次測試留下的資料，讓每次執行都從乾淨狀態開始
  const me = await call('GET', '/auth/me', null, stu);
  const old = await call('GET', `/manage/results?userId=${me.data.user.id}`, null, tea);
  if (old.data.results?.length) {
    await call('POST', '/manage/results/bulk', {
      action: 'delete', ids: old.data.results.map((r) => r.id), force: true,
    }, adm);
  }
  ok(true, `清掉 ${old.data.results?.length || 0} 筆前次測試資料`);

  console.log('\n權限');
  const noAuth = await call('GET', '/users');
  ok(noAuth.status === 401, '未登入無法讀取使用者清單');
  const stuUsers = await call('GET', '/users', null, stu);
  ok(stuUsers.status === 403, '學生無法讀取使用者清單');
  const teaUsers = await call('GET', '/users', null, tea);
  ok(teaUsers.status === 200, '老師可以讀取使用者清單');

  console.log('\n考試指派');
  const avail = await call('GET', '/exam/available', null, stu);
  ok(avail.data.available?.length > 0, '學生看得到被指派的考試');
  const a = avail.data.available[0];
  ok(a.modules.length === 4, '四科都被指派');

  console.log('\n開始考試');
  const start = await call('POST', '/exam/start', { assignmentId: a.assignmentId, testId: a.testId }, stu);
  ok(start.status === 200 && start.data.attemptId, '建立考試場次');
  const attemptId = start.data.attemptId;

  const again = await call('POST', '/exam/start', { assignmentId: a.assignmentId, testId: a.testId }, stu);
  ok(again.data.attemptId === attemptId && again.data.resumed, '重複開始會接續同一場，不會重開');

  console.log('\n取得考卷');
  const paperRes = await call('GET', `/exam/${attemptId}`, null, stu);
  ok(paperRes.status === 200, '取得考卷');
  const studentPaper = paperRes.data.paper;

  const leaked = JSON.stringify(studentPaper).match(/"answers"/);
  ok(!leaked, '學生版考卷不含任何答案');
  const leakedExp = JSON.stringify(studentPaper).match(/"explanation"/);
  ok(!leakedExp, '學生版考卷不含解析');
  const leakedTranscript = JSON.stringify(studentPaper).match(/"transcript"/);
  ok(!leakedTranscript, '考試中不提供聽力逐字稿');
  ok(studentPaper.modules.length === 4, '四科都在考卷裡');

  // 老師端取得含答案的版本，用來作答
  const full = await call('GET', `/tests/${a.testId}`, null, tea);
  ok(full.status === 200 && full.data.paper, '老師可取得含答案的試卷');
  const key = normalizePaper(full.data.paper);

  console.log('\n時間控管');
  const before = await call('POST', `/exam/${attemptId}/answers`, { items: [{ module: 'listening', number: 1, response: 'x' }] }, stu);
  ok(before.status === 200, '尚未開始該科也能存草稿（不擋）');

  const modStart = await call('POST', `/exam/${attemptId}/module/start`, { module: 'listening' }, stu);
  ok(modStart.data.endsAt > Date.now(), '伺服器發出聽力結束時間');
  ok(modStart.data.durationSec === 1800 + 120, `聽力時長 ${modStart.data.durationSec} 秒（30 分 + 2 分轉答案）`);

  const restart = await call('POST', `/exam/${attemptId}/module/start`, { module: 'listening' }, stu);
  ok(restart.data.resumed === true && restart.data.endsAt === modStart.data.endsAt, '重新進入不會重置計時');

  console.log('\n作答（聽力全對、閱讀故意錯 5 題）');
  const listening = flattenQuestions(key, 'listening');
  await call('POST', `/exam/${attemptId}/answers`, {
    items: listening.map((q) => ({
      module: 'listening', number: q.number,
      response: q.type === 'mcq_multi' ? q.answers.join(',') : q.answers[0],
    })),
  }, stu);
  ok(true, `送出聽力 ${listening.length} 題`);

  await call('POST', `/exam/${attemptId}/module/finish`, { module: 'listening' }, stu);
  const afterFinish = await call('POST', `/exam/${attemptId}/answers`, {
    items: [{ module: 'listening', number: 1, response: 'changed' }],
  }, stu);
  ok(afterFinish.data.rejected?.length === 1, '交完的科目不能再改答案');

  await call('POST', `/exam/${attemptId}/module/start`, { module: 'reading' }, stu);
  const reading = flattenQuestions(key, 'reading');
  const wrongSet = new Set(reading.slice(0, 5).map((q) => q.number));
  await call('POST', `/exam/${attemptId}/answers`, {
    items: reading.map((q) => ({
      module: 'reading', number: q.number,
      response: wrongSet.has(q.number) ? '' : (q.type === 'mcq_multi' ? q.answers.join(',') : q.answers[0]),
      flagged: q.number === 7 ? 1 : 0,
    })),
  }, stu);
  ok(true, `送出閱讀 ${reading.length} 題（前 5 題留白）`);
  await call('POST', `/exam/${attemptId}/module/finish`, { module: 'reading' }, stu);

  console.log('\n寫作');
  await call('POST', `/exam/${attemptId}/module/start`, { module: 'writing' }, stu);
  const w1 = await call('POST', `/exam/${attemptId}/writing`, {
    taskNo: 1, essay: 'The chart shows how commuting patterns changed. '.repeat(12),
  }, stu);
  ok(w1.data.wordCount > 60, `Task 1 字數統計 = ${w1.data.wordCount}`);
  await call('POST', `/exam/${attemptId}/writing`, {
    taskNo: 2, essay: 'In my opinion community service should be encouraged rather than compulsory. '.repeat(20),
  }, stu);
  ok(true, '送出 Task 2');
  await call('POST', `/exam/${attemptId}/module/finish`, { module: 'writing' }, stu);

  console.log('\n口說');
  const sp = await call('POST', `/exam/${attemptId}/module/start`, { module: 'speaking' }, stu);
  ok(sp.status === 200, '開始口說');
  // 沒有麥克風，直接送逐字稿模擬
  const spRes = await fetch(`${BASE}/api/speaking/${attemptId}/response`, {
    method: 'POST',
    headers: { authorization: `Bearer ${stu}` },
    body: (() => {
      const fd = new FormData();
      fd.append('part', '1'); fd.append('qIndex', '0');
      fd.append('question', 'Do you work or are you a student?');
      fd.append('duration', '32');
      fd.append('transcript', 'I am a student. I am studying civil engineering at university and I am in my third year.');
      return fd;
    })(),
  });
  ok(spRes.ok, '上傳口說逐字稿');
  await call('POST', `/exam/${attemptId}/module/finish`, { module: 'speaking' }, stu);

  console.log('\n交卷與批改');
  const submit = await call('POST', `/exam/${attemptId}/submit`, {}, stu);
  ok(submit.status === 200, '交卷成功');

  let status = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    status = (await call('GET', `/exam/${attemptId}/status`, null, stu)).data;
    if (['graded', 'grading'].includes(status.status) && status.listening_band != null) break;
  }
  ok(status.listening_band != null, `聽力已批改 → Band ${status.listening_band}`);
  ok(Number(status.listening_band) === 9, '聽力全對 = Band 9', `拿到 ${status.listening_band}`);
  ok(status.reading_band != null && Number(status.reading_band) < 9, `閱讀錯 5 題 → Band ${status.reading_band}`);

  console.log('\n成績單');
  const result = await call('GET', `/results/${attemptId}`, null, stu);
  ok(result.status === 200, '取得成績資料');
  const R = result.data;
  ok(R.moduleResults.listening?.rawScore === listening.length, `聽力原始分 ${R.moduleResults.listening?.rawScore}/${R.moduleResults.listening?.total}`);
  ok(R.moduleResults.reading?.rawScore === reading.length - 5, `閱讀原始分 ${R.moduleResults.reading?.rawScore}/${R.moduleResults.reading?.total}`);
  ok(R.review.listening?.length === listening.length, '有聽力逐題檢討');
  ok(R.review.reading?.some((q) => !q.correct && q.answers?.length), '錯題會顯示正解');
  ok(!!R.candidate.name, `考生資料：${R.candidate.name} / ${R.candidate.candidate_no || '—'}`);
  ok(R.writing?.length === 2, '兩篇作文都有紀錄');
  ok(R.speaking?.length >= 1, '口說有紀錄');

  console.log('\n老師改分');
  const override = await call('POST', `/results/${attemptId}/grade`, {
    module: 'speaking', criteria: { FC: 6, LR: 6, GRA: 7, PRO: 6 }, comment: '整體流暢，注意時態。',
  }, tea);
  ok(override.status === 200, '老師手動給口說分數');
  ok(Number(override.data.summary.speaking) === 6.5, `口說 = 6.5（6+6+7+6 平均）`, `拿到 ${override.data.summary.speaking}`);

  await call('POST', `/results/${attemptId}/grade`, {
    module: 'writing', taskNo: 1, band: 6, criteria: { TA: 6, CC: 6, LR: 6, GRA: 6 }, comment: 'ok',
  }, tea);
  const w2 = await call('POST', `/results/${attemptId}/grade`, {
    module: 'writing', taskNo: 2, band: 6.5, criteria: { TA: 7, CC: 6, LR: 6, GRA: 7 }, comment: 'ok',
  }, tea);
  ok(Number(w2.data.summary.writing) === 6.5, '寫作 Task2 加權兩倍 → 6.5', `拿到 ${w2.data.summary.writing}`);
  ok(w2.data.summary.overall != null, `總分 ${w2.data.summary.overall}`);
  ok(w2.data.summary.status === 'graded', '四科齊全後狀態變成已完成');

  console.log('\n學生只能看自己的成績');
  const other = await call('POST', '/auth/login', { username: 'student2', password: 'ielts1234' });
  const peek = await call('GET', `/results/${attemptId}`, null, other.data.token);
  ok(peek.status === 403, '別的學生看不到這份成績');

  console.log('\n匯入功能');
  const tpl = await fetch(`${BASE}/api/import/template.xlsx?token=${encodeURIComponent(tea)}`);
  ok(tpl.ok && Number(tpl.headers.get('content-length')) > 3000, 'Excel 範本可下載');

  const badJson = await call('POST', '/import/json', { paper: { title: 'x', modules: [{ module: 'reading', sections: [{ groups: [{ type: 'tfng', questions: [{ number: 1, answers: ['MAYBE'] }] }] }] }] } }, tea);
  ok(badJson.data.ok === false && badJson.data.errors.length > 0, '格式錯誤的匯入會回報錯誤');

  const goodJson = await call('POST', '/import/json', { paper: require('../samples/question-type-reference.json') }, tea);
  ok(goodJson.data.ok === true, '題型範本可以匯入');

  // ── 管理服務 ───────────────────────────────────────────
  console.log('\n口說即時語音');
  const rt = await call('GET', '/speaking/realtime/status', null, stu);
  ok(typeof rt.data.ok === 'boolean', `即時語音可用性檢查：${rt.data.ok ? '可用' : '未設定（會自動退回問答模式）'}`);
  const live = await call('GET', `/speaking/${attemptId}/live`, null, stu);
  ok(live.status === 200, '可查詢口說即時分數');
  const mon = await call('GET', '/speaking/monitor/active', null, tea);
  ok(Array.isArray(mon.data.sessions), '老師可讀取即時監看清單');
  const monStu = await call('GET', '/speaking/monitor/active', null, stu);
  ok(monStu.status === 403, '學生不能看即時監看');

  console.log('\n資料總覽');
  const ov = await call('GET', '/manage/overview', null, tea);
  ok(ov.status === 200 && ov.data.counts.attempts > 0, `資料總覽：${ov.data.counts.attempts} 場考試，資料庫 ${(ov.data.dbBytes / 1048576).toFixed(2)} MB`);
  ok(ov.data.storage.totalBytes >= 0 && ov.data.policy, '含空間統計與保留政策');
  const ovStu = await call('GET', '/manage/overview', null, stu);
  ok(ovStu.status === 403, '學生看不到資料總覽');

  console.log('\n檔案管理');
  const fd = new FormData();
  fd.append('files', new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'image/png' }), 'unit-test.png');
  fd.append('folder', '測試資料夾');
  const up = await fetch(`${BASE}/api/media`, { method: 'POST', headers: { authorization: `Bearer ${tea}` }, body: fd });
  const upData = await up.json();
  ok(up.ok && upData.media?.length === 1, '上傳媒體檔');
  const mediaId = upData.media[0].id;

  const mlist = await call('GET', '/manage/media?unusedOnly=1', null, tea);
  ok(mlist.data.media.some((m) => m.id === mediaId && m.usedBy.length === 0), '正確標示出「沒有被試卷使用」的檔案');
  ok(mlist.data.folders.some((f) => f.name === '測試資料夾'), '資料夾統計正確');

  const moved = await call('POST', '/manage/media/bulk', { action: 'move', ids: [mediaId], folder: '搬過去' }, tea);
  ok(moved.data.moved === 1, '批次移動資料夾');

  const delMedia = await call('POST', '/manage/media/bulk', { action: 'delete', ids: [mediaId] }, tea);
  ok(delMedia.data.deleted === 1, `刪除媒體檔並釋放 ${delMedia.data.freedBytes} bytes`);

  console.log('\n成績管理');
  const filtered = await call('GET', '/manage/results?status=graded', null, tea);
  ok(filtered.data.results.every((r) => r.status === 'graded'), '依狀態篩選成績');
  const byClass = await call('GET', '/manage/results?classGroup=示範班', null, tea);
  ok(byClass.data.summary.count > 0, `依班級篩選：${byClass.data.summary.count} 筆`);

  const preview = await call('POST', '/manage/results/bulk', { action: 'preview', filter: { beforeMonths: 999 } }, tea);
  ok(preview.data.affected === 0, '999 個月前沒有資料（試算不會誤刪）');

  const noFilter = await call('POST', '/manage/results/bulk', { action: 'delete', filter: {} }, adm);
  ok(noFilter.status === 400, '沒有任何條件時拒絕批次刪除（防呆）');

  const arch = await call('POST', '/manage/results/bulk', { action: 'archive', ids: [attemptId] }, tea);
  ok(arch.data.affected === 1, '封存單筆成績');
  const archList = await call('GET', '/manage/results?archived=1', null, tea);
  ok(archList.data.results.some((r) => r.id === attemptId), '可以只列出已封存的成績');
  await call('POST', '/manage/results/bulk', { action: 'unarchive', ids: [attemptId] }, tea);
  ok(true, '取消封存');

  const teaDel = await call('POST', '/manage/results/bulk', { action: 'delete', ids: [attemptId] }, tea);
  ok(teaDel.status === 403, '老師不能刪除成績（只有管理員可以）');

  const csv = await fetch(`${BASE}/api/manage/results/export.csv?classGroup=${encodeURIComponent('示範班')}&token=${encodeURIComponent(tea)}`);
  const csvText = await csv.text();
  ok(csv.ok && csvText.includes('學生') && csvText.split('\n').length > 1, '匯出成績 CSV');

  console.log('\n試卷管理');
  const mt = await call('GET', '/manage/tests', null, tea);
  // 找真正被考過的那一份，不要假設它排在第一個
  const mtRow = mt.data.tests.find((t) => t.id === a.testId) || mt.data.tests[0];
  ok(mtRow.attempts > 0, `試卷管理顯示考試紀錄數：${mtRow.attempts}`);
  const testId = mtRow.id;
  await call('POST', '/manage/tests/bulk', { action: 'archive', ids: [testId] }, tea);
  const mt2 = await call('GET', '/manage/tests', null, tea);
  ok(mt2.data.tests.find((t) => t.id === testId).archived === 1, '封存試卷');
  await call('POST', '/manage/tests/bulk', { action: 'unarchive', ids: [testId] }, tea);
  await call('POST', '/manage/tests/bulk', { action: 'publish', ids: [testId] }, tea);
  ok(true, '取消封存並重新發布');

  const guard = await call('POST', '/manage/tests/bulk', { action: 'delete', ids: [testId] }, adm);
  ok(guard.status === 409 && guard.data.needsForce, '刪除有成績的試卷會先攔下來要求確認');

  const backup = await fetch(`${BASE}/api/manage/backup/test/${testId}.json?token=${encodeURIComponent(tea)}`);
  const backupData = await backup.json();
  ok(backup.ok && backupData.test && backupData.attempts.length > 0,
    `完整備份含試卷與 ${backupData.attempts?.length} 場考試`);

  console.log('\n保留政策與清理');
  const pol = await call('PUT', '/manage/policy', {
    policy: { keepResultsMonths: 36, keepAbandonedDays: 30, keepAiLogsDays: 7, enabled: false },
  }, adm);
  ok(pol.data.policy.keepResultsMonths === 36, '儲存保留政策');

  const polTea = await call('PUT', '/manage/policy', { policy: { keepResultsMonths: 1 } }, tea);
  ok(polTea.status === 403, '老師不能改保留政策');

  const dry = await call('POST', '/manage/cleanup', { dryRun: true, policy: { keepResultsMonths: 999 } }, tea);
  ok(dry.data.report.dryRun === true && dry.data.report.affected === 0, '試算不會刪除任何東西');

  const realTea = await call('POST', '/manage/cleanup', { dryRun: false }, tea);
  ok(realTea.status === 403, '老師不能實際執行清理');

  const abandoned = await call('POST', '/manage/cleanup', {
    dryRun: true, policy: { keepAbandonedDays: 0, keepResultsMonths: 0, keepAiLogsDays: 0, deleteUnusedMediaDays: 0, keepSpeakingAudioMonths: 0 },
  }, adm);
  ok(abandoned.data.report.affected === 0, '保留天數設 0 代表永久保留，不會刪除');

  const mlog = await call('GET', '/manage/log', null, tea);
  ok(Array.isArray(mlog.data.log) && mlog.data.log.length > 0, `維護紀錄有 ${mlog.data.log.length} 筆`);

  // ── 老師自訂的考試規則 ─────────────────────────────────
  console.log('\n考試規則：時間 / 反作弊 / 休息');

  const presets = await call('GET', '/tests/exam-rules/presets', null, tea);
  ok(presets.data.officialDurations.listening === 1800 + 0 || presets.data.officialDurations.listening > 0,
    `取得官方時間預設：聽力 ${presets.data.officialDurations.listening / 60} 分、閱讀 ${presets.data.officialDurations.reading / 60} 分`);
  ok(Object.keys(presets.data.breakPolicies).length === 3, '三種休息政策：官方連續 / 固定休息 / 自由');

  // 用 student5 開一場「自訂規則」的考試
  const s5 = await call('POST', '/auth/login', { username: 'student5', password: 'ielts1234' });
  const stu5 = s5.data.token;
  const me5 = await call('GET', '/auth/me', null, stu5);
  const old5 = await call('GET', `/manage/results?userId=${me5.data.user.id}`, null, tea);
  if (old5.data.results?.length) {
    await call('POST', '/manage/results/bulk', {
      action: 'delete', ids: old5.data.results.map((r) => r.id), force: true,
    }, adm);
  }

  const ruleAsg = await call('POST', '/tests/assignments', {
    testId: a.testId, userIds: [me5.data.user.id],
    modules: 'listening,reading,writing,speaking',
    maxAttempts: 5,
    durationOverrides: { listening: 40 * 60 },   // 聽力改成 40 分鐘
    extraTimePct: 25,                            // 全部再加 25%
    breakPolicy: 'official',
    proctoring: { enabled: true, requireFullscreen: true, blockCopy: true, warnOnLeave: true, maxLeaves: 2, onExceed: 'submit' },
  }, tea);
  ok(ruleAsg.status === 200 && ruleAsg.data.ids.length === 1, '建立帶有自訂規則的指派');

  const start5 = await call('POST', '/exam/start', { assignmentId: ruleAsg.data.ids[0], testId: a.testId }, stu5);
  const att5 = start5.data.attemptId;
  ok(!!att5, '學生開始這場考試');

  const paper5 = await call('GET', `/exam/${att5}`, null, stu5);
  const RULES = paper5.data.rules;
  ok(!!R, '考卷帶回考試規則');
  ok(RULES.durations.listening === Math.round(40 * 60 * 1.25),
    `聽力 40 分 + 25% 加時 = ${RULES.durations.listening / 60} 分`, `拿到 ${RULES.durations.listening}`);
  ok(RULES.durations.reading === Math.round(3600 * 1.25),
    `閱讀沿用試卷的 60 分 + 25% = ${RULES.durations.reading / 60} 分`, `拿到 ${RULES.durations.reading}`);
  ok(RULES.extraTimePct === 25, '加時百分比正確帶出');
  ok(RULES.break.policy === 'official' && Array.isArray(RULES.break.chain),
    `休息政策 = 官方連續，連鎖順序 ${RULES.break.chain.join(' → ')}`);
  ok(!RULES.break.chain.includes('speaking'), '口說不納入連續作答（官方就是獨立進行）');
  ok(RULES.proctoring.enabled && RULES.proctoring.requireFullscreen && RULES.proctoring.maxLeaves === 2,
    '監考設定正確帶出（全螢幕、上限 2 次、超過自動收卷）');

  const ms5 = await call('POST', `/exam/${att5}/module/start`, { module: 'listening' }, stu5);
  ok(ms5.data.durationSec === Math.round(40 * 60 * 1.25),
    `伺服器實際發出的時限也是 ${ms5.data.durationSec / 60} 分（前端改不動）`);
  ok(ms5.data.breakdown.overrideSec === 2400 && ms5.data.breakdown.extraSec === 600,
    '時間組成拆解正確：覆寫 2400 秒 + 加時 600 秒');

  console.log('\n監考事件');
  const ev1 = await call('POST', `/exam/${att5}/event`, { type: 'leave', module: 'listening', detail: '切換分頁' }, stu5);
  ok(ev1.data.leaveCount === 1, `記錄第 1 次離開（目前 ${ev1.data.leaveCount} 次）`);
  const ev2 = await call('POST', `/exam/${att5}/event`, { type: 'fullscreen_exit', module: 'listening' }, stu5);
  ok(ev2.data.leaveCount === 2, '離開全螢幕也計入同一個上限');
  await call('POST', `/exam/${att5}/event`, { type: 'copy_blocked', module: 'listening', detail: '嘗試複製文章' }, stu5);
  const badEvent = await call('POST', `/exam/${att5}/event`, { type: '亂寫的事件' }, stu5);
  ok(badEvent.status === 400, '不認識的事件類型會被拒絕');

  const evList = await call('GET', `/exam/${att5}/events`, null, tea);
  ok(evList.data.counts.leave === 1 && evList.data.counts.fullscreen_exit === 1 && evList.data.counts.copy_blocked === 1,
    `老師看得到完整事件：${JSON.stringify(evList.data.counts)}`);
  ok(evList.data.events.some((e) => e.type === 'module_start'), '開始作答本身也會留下紀錄');

  const evStu = await call('GET', `/exam/${att5}/events`, null, stu5);
  ok(evStu.status === 403, '學生看不到事件明細');

  // 成績頁要帶出紀律摘要
  await call('POST', `/exam/${att5}/module/finish`, { module: 'listening' }, stu5);
  const res5 = await call('GET', `/results/${att5}`, null, tea);
  ok(res5.data.conduct?.leaveCount === 2, `成績頁顯示離開次數 ${res5.data.conduct?.leaveCount}`);
  ok(res5.data.conduct?.events?.length > 0, '老師在成績頁看得到事件時間軸');
  const res5stu = await call('GET', `/results/${att5}`, null, stu5);
  ok(res5stu.data.conduct?.events?.length === 0, '學生在成績頁看不到事件明細');

  console.log('\n預設值（沒特別設定時不應該改變原本行為）');
  const plain = await call('GET', `/exam/${attemptId}`, null, stu);
  ok(plain.data.rules.proctoring.enabled === false, '沒開監考時預設關閉');
  ok(plain.data.rules.break.policy === 'flexible', '沒設休息政策時預設自由');
  ok(plain.data.rules.durations.listening === 1920, '沒改時間時沿用試卷的 30 分 + 2 分轉答案');

  // ── 登入人機驗證（Cloudflare Turnstile）────────────────
  // 用 Cloudflare 官方提供的測試金鑰，不需要真的申請帳號
  const TS_SITE_PASS = '1x00000000000000000000AA';
  const TS_SECRET_PASS = '1x0000000000000000000000000000000AA';
  const TS_SECRET_FAIL = '2x0000000000000000000000000000000AA';

  console.log('\n登入人機驗證');
  const cfg0 = await call('GET', '/auth/config');
  ok(cfg0.status === 200, '未登入也能讀取登入頁的公開設定');
  ok(cfg0.data.turnstile.enabled === false, '預設關閉，不影響原本的登入');
  ok(!('secretKey' in cfg0.data.turnstile), '公開設定裡沒有 Secret Key 這個欄位');

  const tsTea = await call('PUT', '/manage/turnstile', { turnstile: { enabled: true } }, tea);
  ok(tsTea.status === 403, '老師不能改人機驗證設定（只有管理員）');

  // 開啟（永遠通過的測試金鑰）
  const on = await call('PUT', '/manage/turnstile', {
    turnstile: { enabled: true, siteKey: TS_SITE_PASS, secretKey: TS_SECRET_PASS, failOpen: true },
  }, adm);
  ok(on.data.turnstile.active === true, '管理員啟用人機驗證');
  ok(/••••/.test(on.data.turnstile.secretKey), `後台只看得到遮罩後的 Secret Key：${on.data.turnstile.secretKey}`);

  const cfg1 = await call('GET', '/auth/config');
  ok(cfg1.data.turnstile.enabled === true && cfg1.data.turnstile.siteKey === TS_SITE_PASS,
    '登入頁拿得到 Site Key（Site Key 本來就是公開的）');
  ok(!JSON.stringify(cfg1.data).includes(TS_SECRET_PASS), 'Secret Key 沒有外洩到公開設定');

  const noToken = await call('POST', '/auth/login', { username: 'student1', password: 'ielts1234' });
  ok(noToken.status === 400 && noToken.data.turnstileFailed, '沒帶驗證 token 會被擋下');
  ok(/人機驗證/.test(noToken.data.error), `錯誤訊息看得懂：「${noToken.data.error}」`);

  const withToken = await call('POST', '/auth/login', {
    username: 'student1', password: 'ielts1234', turnstileToken: 'dummy-token-for-testing',
  });
  ok(withToken.status === 200 && withToken.data.token, '帶著驗證 token 就能正常登入');

  const wrongPw = await call('POST', '/auth/login', {
    username: 'student1', password: '錯的密碼', turnstileToken: 'dummy-token-for-testing',
  });
  ok(wrongPw.status === 401, '通過人機驗證後，密碼還是要對');

  // 換成永遠失敗的金鑰，確認真的有打到 Cloudflare
  await call('PUT', '/manage/turnstile', { turnstile: { secretKey: TS_SECRET_FAIL } }, adm);
  const rejected = await call('POST', '/auth/login', {
    username: 'student1', password: 'ielts1234', turnstileToken: 'dummy-token-for-testing',
  });
  ok(rejected.status === 400 && rejected.data.turnstileFailed,
    'Cloudflare 判定驗證失敗時，就算帳密正確也登不進去');

  // 這一項會實際打到 Cloudflare。CI 上外網不一定通，所以只要求它「有在時限內回話」，
  // 不要求一定連得上——路由本身有 10 秒逾時，不會把請求掛住。
  const tsStart = Date.now();
  const tsTest = await call('POST', '/manage/turnstile/test', {}, adm);
  const tsMs = Date.now() - tsStart;
  ok(typeof tsTest.data.ok === 'boolean' && tsMs < 20000,
    `「測試 Secret Key」${tsMs} ms 內有回應：${tsTest.data.message || tsTest.data.error}`);

  // 關掉，把環境還原，免得影響之後的測試與實際部署
  const off = await call('PUT', '/manage/turnstile', {
    turnstile: { enabled: false, siteKey: '', secretKey: '' },
  }, adm);
  ok(off.data.turnstile.active === false, '關閉後還原');
  const back = await call('POST', '/auth/login', { username: 'student1', password: 'ielts1234' });
  ok(back.status === 200, '關閉後不帶 token 也能正常登入');

  // ── 成員管理 ───────────────────────────────────────────
  console.log('\n成員管理');
  const stamp = Date.now().toString(36);

  const list0 = await call('GET', '/users', null, tea);
  ok(list0.data.summary?.student?.total >= 5,
    `成員清單帶回統計：管理員 ${list0.data.summary.admin?.total} 老師 ${list0.data.summary.teacher?.total} 學生 ${list0.data.summary.student?.total}`);
  ok(list0.data.users.every((u) => 'attempts' in u), '每位成員都帶出考試場次數（刪除前才知道會失去什麼）');
  ok(typeof list0.data.adminCount === 'number', `目前啟用中的管理員 ${list0.data.adminCount} 位`);

  const multi = await call('GET', '/users?role=admin,teacher', null, tea);
  ok(multi.data.users.every((u) => u.role !== 'student'), '可以一次篩選多個角色（?role=admin,teacher）');

  // 老師只能管學生
  const teaMakeTeacher = await call('POST', '/users', {
    username: `t_${stamp}`, password: 'pw123456', name: '老師想建老師', role: 'teacher',
  }, tea);
  ok(teaMakeTeacher.status === 403, '老師不能建立老師帳號');

  const teaMakeStudent = await call('POST', '/users', {
    username: `s_${stamp}`, password: 'pw123456', name: '老師建的學生', role: 'student', classGroup: '測試班',
  }, tea);
  ok(teaMakeStudent.status === 200, '老師可以建立學生');
  const stuId = teaMakeStudent.data.id;

  // 管理員可以建立任何角色
  const newTeacher = await call('POST', '/users', {
    username: `nt_${stamp}`, password: 'pw123456', name: '新老師', role: 'teacher', email: 'nt@x.com',
  }, adm);
  ok(newTeacher.status === 200, '管理員可以建立老師');
  const teaId = newTeacher.data.id;

  const newAdmin = await call('POST', '/users', {
    username: `na_${stamp}`, password: 'pw123456', name: '第二管理員', role: 'admin',
  }, adm);
  ok(newAdmin.status === 200, '管理員可以建立另一位管理員');
  const admId = newAdmin.data.id;

  const dup = await call('POST', '/users', {
    username: `nt_${stamp}`, password: 'pw123456', name: '重複帳號', role: 'teacher',
  }, adm);
  ok(dup.status === 409, '帳號重複會被擋下');

  // 老師不能改老師
  const teaEditTeacher = await call('PUT', `/users/${teaId}`, { name: '亂改' }, tea);
  ok(teaEditTeacher.status === 403, '老師不能修改其他老師的資料');

  // 停用 / 啟用
  await call('PUT', `/users/${stuId}`, { active: false }, tea);
  const offList = await call('GET', '/users?active=0', null, tea);
  ok(offList.data.users.some((u) => u.id === stuId), '停用後可以用 ?active=0 篩出來');
  await call('PUT', `/users/${stuId}`, { active: true }, tea);

  // 最後一位管理員的防呆（此時有 admin 與第二管理員兩位，先刪掉第二位再測）
  const impactAdm = await call('GET', `/users/${admId}/impact`, null, adm);
  ok(impactAdm.data.isLastAdmin === false, '還有其他管理員時，不會被標成「最後一位」');

  await call('DELETE', `/users/${admId}`, null, adm);
  const impactLast = await call('GET', '/users/1/impact', null, adm);
  ok(impactLast.data.isLastAdmin === true, '刪掉第二位管理員後，原管理員被標成最後一位');

  const selfDel = await call('DELETE', '/users/1', null, adm);
  ok(selfDel.status === 400, '不能刪除自己');

  // 用第二位管理員來測「不能停用最後一位管理員」
  const adm2 = await call('POST', '/users', {
    username: `na2_${stamp}`, password: 'pw123456', name: '暫時管理員', role: 'admin',
  }, adm);
  const adm2Token = (await call('POST', '/auth/login', { username: `na2_${stamp}`, password: 'pw123456' })).data.token;
  await call('PUT', '/users/1', { active: false }, adm2Token);   // 先把原管理員停用
  const lastOff = await call('PUT', `/users/${adm2.data.id}`, { active: false }, adm2Token);
  ok(lastOff.status === 400 && /最後一位/.test(lastOff.data.error), '不能停用最後一位管理員');
  const lastDemote = await call('PUT', `/users/${adm2.data.id}`, { role: 'teacher' }, adm2Token);
  ok(lastDemote.status === 400, '也不能把最後一位管理員降級成老師');
  await call('PUT', '/users/1', { active: true }, adm2Token);    // 還原
  await call('DELETE', `/users/${adm2.data.id}`, null, adm);

  // 刪除老師：會帶回影響
  const teaImpact = await call('GET', `/users/${teaId}/impact`, null, adm);
  ok(typeof teaImpact.data.attempts === 'number' && typeof teaImpact.data.testsCreated === 'number',
    '刪除前可以查到會失去幾場考試、幾份試卷會變成無主');
  const delTea = await call('DELETE', `/users/${teaId}`, null, adm);
  ok(delTea.status === 200, '管理員可以刪除老師');

  const teaDelStudent = await call('DELETE', `/users/${stuId}`, null, tea);
  ok(teaDelStudent.status === 403, '老師不能刪除成員（只能停用）');

  // 批次操作
  const b1 = await call('POST', '/users/bulk-action', { action: 'deactivate', ids: [stuId] }, tea);
  ok(b1.data.affected === 1, '老師可以批次停用學生');
  const b2 = await call('POST', '/users/bulk-action', { action: 'activate', ids: [stuId] }, tea);
  ok(b2.data.affected === 1, '批次啟用');

  const bSelf = await call('POST', '/users/bulk-action', { action: 'deactivate', ids: [1] }, adm);
  ok(bSelf.status === 400, '批次操作不能包含自己');

  // 用管理員（id 1）當目標，確定不是「操作自己」那條規則先擋下來
  const bStaff = await call('POST', '/users/bulk-action', { action: 'deactivate', ids: [1] }, tea);
  ok(bStaff.status === 403, '老師不能批次操作老師或管理員');

  const bDelTea = await call('POST', '/users/bulk-action', { action: 'delete', ids: [stuId] }, tea);
  ok(bDelTea.status === 403, '老師不能批次刪除');

  const bDel = await call('POST', '/users/bulk-action', { action: 'delete', ids: [stuId] }, adm);
  ok(bDel.data.deleted === 1, '管理員可以批次刪除，並回報連帶刪掉幾場考試');

  const gone = await call('GET', `/users?q=${stamp}`, null, adm);
  ok(gone.data.users.length === 0, '刪掉的成員真的不見了');

  const mlog2 = await call('GET', '/manage/log', null, tea);
  ok(mlog2.data.log.some((r) => r.action === 'user_delete' || r.action === 'users_delete'),
    '刪除成員會留下維護紀錄');

  // ── 題庫 ───────────────────────────────────────────────
  console.log('\n題庫');
  const bankGroup = (n, start) => ({
    type: 'tfng',
    instructions: 'Do the following statements agree with the information given in the passage?',
    questions: Array.from({ length: n }, (_, i) => ({
      number: start + i,
      prompt: `Statement ${start + i} about ${stamp}.`,
      answers: ['TRUE'],
    })),
  });

  const bankBad = await call('POST', '/ai/bank', { module: 'reading', type: 'tfng', payload: {} }, tea);
  ok(bankBad.status === 400, '沒有題組的 payload 存不進題庫');

  const bankNoMod = await call('POST', '/ai/bank', { payload: { group: bankGroup(2, 1) } }, tea);
  ok(bankNoMod.status === 400, '缺少 module / type 會被擋下');

  const bk1 = await call('POST', '/ai/bank', {
    module: 'reading', type: 'tfng', topic: `題庫測試 ${stamp}`, difficulty: 'band 6-7',
    tags: 'e2e,環境',
    payload: { group: bankGroup(3, 1), passage: 'A passage about urban greening.', passageTitle: 'Urban Greening' },
  }, tea);
  ok(bk1.status === 200 && bk1.data.id > 0, '可以把題組存進題庫');

  const bk2 = await call('POST', '/ai/bank', {
    module: 'listening', type: 'gap_fill', topic: `題庫測試2 ${stamp}`,
    payload: { group: { type: 'gap_fill', questions: [{ number: 1, prompt: 'The tour starts at ___.', answers: ['9am'] }] }, transcript: 'Welcome…' },
  }, tea);
  ok(bk2.status === 200, '不同科目的題組也存得進去');

  const bankList = await call('GET', '/ai/bank', null, tea);
  ok(bankList.data.total >= 2 && bankList.data.items.length >= 2, `題庫列得出來（共 ${bankList.data.total} 個）`);
  const listed = bankList.data.items.find((i) => i.id === bk1.data.id);
  ok(listed && listed.questionCount === 3, '列表會算出題數');
  ok(listed && listed.creator, '列表帶出建立者姓名');
  ok(!('payload' in (listed || {})), '列表不回傳整包 payload，避免清單過肥');
  ok(Array.isArray(bankList.data.stats) && bankList.data.stats.length > 0, '附上科目／題型統計供篩選用');

  const byMod = await call('GET', '/ai/bank?module=listening', null, tea);
  ok(byMod.data.items.every((i) => i.module === 'listening'), '可依科目篩選');
  const byType = await call('GET', '/ai/bank?type=tfng', null, tea);
  ok(byType.data.items.every((i) => i.type === 'tfng'), '可依題型篩選');
  const bySearch = await call('GET', `/ai/bank?q=${encodeURIComponent(stamp)}`, null, tea);
  ok(bySearch.data.items.length >= 2, '可用關鍵字搜尋主題與內容');
  const bySrc = await call('GET', '/ai/bank?source=ai', null, tea);
  ok(bySrc.data.items.every((i) => i.source === 'ai'), '可依來源篩選');

  const bankStu = await call('GET', '/ai/bank', null, stu);
  ok(bankStu.status === 403, '學生看不到題庫');

  const bankOne = await call('GET', `/ai/bank/${bk1.data.id}`, null, tea);
  ok(bankOne.data.item.payload.group.questions.length === 3, '單筆查詢帶回完整題目');
  ok(bankOne.data.item.payload.passage, '文章內容一起存下來');
  const bankMissing = await call('GET', '/ai/bank/999999', null, tea);
  ok(bankMissing.status === 404, '不存在的題組回 404');

  const bankEdit = await call('PUT', `/ai/bank/${bk1.data.id}`, { topic: `改過的主題 ${stamp}`, tags: '環境' }, tea);
  ok(bankEdit.status === 200, '可以改主題與標籤');
  const afterEdit = await call('GET', `/ai/bank/${bk1.data.id}`, null, tea);
  ok(afterEdit.data.item.topic === `改過的主題 ${stamp}`, '改完真的存進去了');

  // 組成新試卷
  const toNew = await call('POST', '/ai/bank/to-test', {
    ids: [bk1.data.id, bk2.data.id], title: `題庫組卷 ${stamp}`,
  }, tea);
  ok(toNew.data.created === true && toNew.data.testId > 0, '可以把題庫題組組成一份新試卷');
  const newPaper = await call('GET', `/tests/${toNew.data.testId}`, null, tea);
  const mods = (newPaper.data.test?.paper || newPaper.data.paper).modules.map((m) => m.module);
  ok(mods.includes('reading') && mods.includes('listening'), '新試卷同時含兩個科目');

  // 併進現有試卷
  const bkBefore = await call('GET', `/tests/${toNew.data.testId}`, null, tea);
  const beforePaper = bkBefore.data.test?.paper || bkBefore.data.paper;
  const beforeSections = beforePaper.modules.find((m) => m.module === 'reading').sections.length;
  const toExisting = await call('POST', '/ai/bank/to-test', {
    ids: [bk1.data.id], testId: toNew.data.testId,
  }, tea);
  ok(toExisting.data.ok === true && !toExisting.data.created, '可以併進現有試卷');
  const bkAfter = await call('GET', `/tests/${toNew.data.testId}`, null, tea);
  const afterPaper = bkAfter.data.test?.paper || bkAfter.data.paper;
  ok(afterPaper.modules.find((m) => m.module === 'reading').sections.length === beforeSections + 1,
    '併進去之後 section 真的多一個');
  const readNums = flattenQuestions(normalizePaper(afterPaper), 'reading').map((q) => q.number);
  ok(new Set(readNums).size === readNums.length,
    `題號自動接續，不會撞號（${readNums.join(',')}）`);

  const toNone = await call('POST', '/ai/bank/to-test', { ids: [] }, tea);
  ok(toNone.status === 400, '沒選題組不能組卷');
  const toBadTest = await call('POST', '/ai/bank/to-test', { ids: [bk1.data.id], testId: 999999 }, tea);
  ok(toBadTest.status === 404, '併進不存在的試卷回 404');

  await call('DELETE', `/tests/${toNew.data.testId}`, null, adm);

  const delMissing = await call('DELETE', '/ai/bank/999999', null, tea);
  ok(delMissing.status === 404, '刪不存在的題組回 404');
  const delOne = await call('DELETE', `/ai/bank/${bk2.data.id}`, null, tea);
  ok(delOne.status === 200, '可以刪除單一題組');
  const bulkNone = await call('POST', '/ai/bank/bulk-delete', { ids: [] }, tea);
  ok(bulkNone.status === 400, '批次刪除要先選東西');
  const bulkDel = await call('POST', '/ai/bank/bulk-delete', { ids: [bk1.data.id] }, tea);
  ok(bulkDel.data.deleted === 1, '可以批次刪除題組');
  const bankGone = await call('GET', `/ai/bank?q=${encodeURIComponent(stamp)}`, null, tea);
  ok(bankGone.data.items.length === 0, '刪掉的題組真的不見了');

  // ── 自動組卷 ────────────────────────────────────────────
  console.log('\n自動組卷');
  const autoIds = [];
  const autoItem = async (module, type, n, difficulty) => {
    const r = await call('POST', '/ai/bank', {
      module, type, topic: `自動組卷 ${stamp}`, difficulty,
      payload: {
        group: {
          type,
          instructions: 'Answer the questions below.',
          wordLimit: type === 'gap_fill' ? 2 : null,
          questions: Array.from({ length: n }, (_, i) => ({
            number: i + 1,
            prompt: `Auto question ${i + 1}`,
            answers: type === 'tfng' ? ['TRUE'] : ['answer'],
          })),
        },
        passage: module === 'reading' ? '<p>An auto-assembly passage.</p>' : null,
        transcript: module === 'listening' ? 'Auto transcript.' : null,
      },
    }, tea);
    if (r.data.id) autoIds.push(r.data.id);
    return r;
  };
  for (let i = 0; i < 5; i += 1) await autoItem('reading', 'tfng', 5, 'band 6-7');
  for (let i = 0; i < 4; i += 1) await autoItem('reading', 'short_answer', 5, 'band 6-7');
  for (let i = 0; i < 4; i += 1) await autoItem('listening', 'gap_fill', 5, 'band 5-6');
  ok(autoIds.length === 13, `建立 ${autoIds.length} 個題組當素材`);

  const cov = await call('GET', '/ai/bank/coverage', null, tea);
  ok(cov.status === 200 && cov.data.coverage.reading?.questions >= 45,
    `題庫盤點算得出閱讀有幾題（${cov.data.coverage?.reading?.questions}）`);
  ok(cov.data.coverage.reading?.byType?.tfng >= 25, '盤點會分題型統計');
  ok(cov.data.coverage.listening?.byDifficulty?.['band 5-6'] >= 20, '盤點會分難度統計');
  const covStu = await call('GET', '/ai/bank/coverage', null, stu);
  ok(covStu.status === 403, '學生看不到題庫盤點');
  // 這一條擋的是路由順序：/bank/:id 若排在前面，coverage 會被當成 id
  ok(cov.data.coverage !== undefined, 'coverage 沒有被 /bank/:id 吃掉');

  const auto = await call('POST', '/ai/bank/auto', {
    title: `自動組卷 ${stamp}`, targets: { reading: 40, listening: 20 },
  }, tea);
  ok(auto.status === 200 && auto.data.ok === true, '可以自動組出一份合格的試卷');
  ok(auto.data.stats.reading === 40, `閱讀剛好抽到 40 題（實際 ${auto.data.stats?.reading}）`);
  ok(auto.data.stats.listening === 20, `聽力剛好抽到 20 題（實際 ${auto.data.stats?.listening}）`);
  ok(!auto.data.testId, '預設只預覽，不會直接存檔');
  ok((auto.data.report.picked.reading?.typeMix || []).length >= 2, '同一科會混超過一種題型');

  const rMod = auto.data.paper.modules.find((m) => m.module === 'reading');
  ok(rMod.sections.length === 3, '閱讀照官方切成 3 篇');
  ok(auto.data.paper.modules.find((m) => m.module === 'listening').sections.length === 4,
    '聽力照官方切成 4 節');
  ok(rMod.sections.every((s) => !!s.passage), '每一篇都有文章，學生不會開天窗');
  const rNums = rMod.sections.flatMap((s) => s.groups.flatMap((g) => g.questions.map((q) => q.number)));
  ok(new Set(rNums).size === rNums.length, '題號沒有重複');
  ok(rNums[0] === 1 && rNums[rNums.length - 1] === rNums.length, '題號從 1 連續編到底');

  const autoShort = await call('POST', '/ai/bank/auto', {
    title: `缺口測試 ${stamp}`, targets: { reading: 40, writing: 2 },
  }, tea);
  ok(autoShort.data.report.shortfall?.writing?.missing === 2,
    '湊不到的科目會老實回報還差幾題，而不是硬塞');

  const autoSeed1 = await call('POST', '/ai/bank/auto', { targets: { reading: 20 }, seed: 7 }, tea);
  const autoSeed2 = await call('POST', '/ai/bank/auto', { targets: { reading: 20 }, seed: 7 }, tea);
  ok(JSON.stringify(autoSeed1.data.report.usedIds) === JSON.stringify(autoSeed2.data.report.usedIds),
    '同一個 seed 組出來的結果一樣（方便重現）');

  const autoType = await call('POST', '/ai/bank/auto', {
    targets: { reading: 20 }, types: ['short_answer'],
  }, tea);
  ok(autoType.data.paper.modules[0].sections.flatMap((s) => s.groups).every((g) => g.type === 'short_answer'),
    '指定題型時只會抽那一種');

  const autoSave = await call('POST', '/ai/bank/auto', {
    title: `自動存檔 ${stamp}`, targets: { reading: 40 }, save: true,
  }, tea);
  ok(autoSave.data.testId > 0, '可以直接存成試卷');
  const autoTest = await call('GET', `/tests/${autoSave.data.testId}`, null, tea);
  ok(autoTest.status === 200 && autoTest.data.test.published === false,
    '自動組出來的試卷預設沒有發布（要老師先校對）');
  await call('DELETE', `/tests/${autoSave.data.testId}`, null, adm);

  const autoStu = await call('POST', '/ai/bank/auto', { targets: { reading: 40 } }, stu);
  ok(autoStu.status === 403, '學生不能自動組卷');
  if (!cov.data.coverage.speaking) {
    const autoNone = await call('POST', '/ai/bank/auto', { targets: { speaking: 3 } }, tea);
    ok(autoNone.status === 400 && /題庫/.test(autoNone.data.error || ''),
      '題庫沒有那一科的素材時給得出中文錯誤，不會組出空卷');
  } else {
    ok(true, '題庫本來就有口說題組，略過「素材不足」這一項');
  }

  await call('POST', '/ai/bank/bulk-delete', { ids: autoIds }, tea);

  // ── 通知 ────────────────────────────────────────────────
  console.log('\n通知');
  const meStu = await call('GET', '/auth/me', null, stu);
  const stuUid = meStu.data.user.id;

  await call('POST', '/notifications/read', {}, stu);          // 先清乾淨
  const n0 = await call('GET', '/notifications/count', null, stu);
  ok(n0.status === 200 && n0.data.unread === 0, '一開始沒有未讀');

  const nNoTitle = await call('POST', '/notifications/send', { userIds: [stuUid] }, tea);
  ok(nNoTitle.status === 400, '沒有標題不能發通知');
  const nNoTarget = await call('POST', '/notifications/send', { title: '嗨' }, tea);
  ok(nNoTarget.status === 400, '沒有收件者不能發通知');
  const nStu = await call('POST', '/notifications/send',
    { title: '學生不該能發', userIds: [stuUid] }, stu);
  ok(nStu.status === 403, '學生不能發通知給別人');

  const nSend = await call('POST', '/notifications/send',
    { title: `明天要考試 ${stamp}`, body: '請提早十分鐘到教室。', userIds: [stuUid] }, tea);
  ok(nSend.status === 200 && nSend.data.sent === 1, '老師可以發通知給指定學生');

  const nList = await call('GET', '/notifications', null, stu);
  ok(nList.data.unread === 1 && nList.data.items[0].title.includes(stamp), '學生收得到，而且是未讀');
  ok(nList.data.items[0].body === '請提早十分鐘到教室。', '內文有一起送到');

  const nTea = await call('GET', '/notifications', null, tea);
  ok(!nTea.data.items.some((i) => i.title.includes(stamp)), '通知不會外洩給沒收到的人');

  const nOne = await call('POST', '/notifications/read', { ids: [nList.data.items[0].id] }, stu);
  ok(nOne.data.marked === 1, '可以只把指定的一則標成已讀');
  ok((await call('GET', '/notifications/count', null, stu)).data.unread === 0, '未讀數跟著歸零');

  const nOther = await call('POST', '/notifications/read', { ids: [nList.data.items[0].id] }, tea);
  ok(nOther.data.marked === 0, '不能把別人的通知標成已讀');

  // 指派考試時要自動通知
  const nTest = await call('POST', '/tests', {
    paper: normalizePaper({
      title: `通知用試卷 ${stamp}`, testType: 'academic',
      modules: [{ module: 'reading', sections: [{ title: 'Passage 1', passage: 'Text.', groups: [bankGroup(3, 1)] }] }],
    }),
  }, tea);
  const nAssign = await call('POST', '/tests/assignments', {
    testId: nTest.data.id, userIds: [stuUid], openUntil: '2030-01-01T09:00',
  }, tea);
  ok(nAssign.data.ids?.length === 1, '建立一筆指派');
  const nAfter = await call('GET', '/notifications', null, stu);
  ok(nAfter.data.items[0]?.type === 'assignment', '指派考試會自動通知學生');
  ok(nAfter.data.items[0]?.title.includes(stamp), '通知裡看得到是哪一份試卷');
  ok(nAfter.data.items[0]?.link === '#/', '通知點得進去');
  await call('DELETE', `/tests/assignments/${nAssign.data.ids[0]}`, null, tea);
  await call('DELETE', `/tests/${nTest.data.id}`, null, adm);
  await call('POST', '/notifications/read', {}, stu);

  const nLimit = await call('GET', '/notifications?limit=999', null, stu);
  ok(nLimit.status === 200 && nLimit.data.items.length <= 100, 'limit 灌大數字不會拖垮查詢');

  // ── Email 設定 ─────────────────────────────────────────
  console.log('\nEmail 通知設定');
  const smtpStu = await call('GET', '/notifications/smtp', null, stu);
  ok(smtpStu.status === 403, '學生看不到寄信設定');
  const smtpTea = await call('GET', '/notifications/smtp', null, tea);
  ok(smtpTea.status === 200, '老師看得到寄信設定');
  const smtpTeaPut = await call('PUT', '/notifications/smtp', { smtp: { host: 'x' } }, tea);
  ok(smtpTeaPut.status === 403, '老師不能改寄信設定');

  const smtpSave = await call('PUT', '/notifications/smtp', {
    smtp: {
      enabled: false, host: 'smtp.invalid.test', port: 587, secure: false,
      user: 'u@invalid.test', pass: `pw-${stamp}`, from: 'noreply@invalid.test', fromName: '測試寄件人',
    },
  }, adm);
  ok(smtpSave.status === 200 && smtpSave.data.smtp.pass === '••••••', '存完回傳的密碼是遮罩的');
  ok(smtpSave.data.smtp.hasPass === true, '但會告訴你密碼已經設好了');
  const smtpGet = await call('GET', '/notifications/smtp', null, adm);
  ok(smtpGet.data.smtp.pass === '••••••' && !JSON.stringify(smtpGet.data).includes(stamp),
    '重新讀取也絕對不會把密碼吐回瀏覽器');
  ok(smtpGet.data.smtp.fromName === '測試寄件人', '中文寄件人名稱存得住');
  ok(smtpGet.data.smtp.active === false, '沒有啟用時 active 是 false');

  await call('PUT', '/notifications/smtp', { smtp: { host: 'smtp2.invalid.test', pass: '••••••' } }, adm);
  const smtpKeep = await call('GET', '/notifications/smtp', null, adm);
  ok(smtpKeep.data.smtp.hasPass === true && smtpKeep.data.smtp.host === 'smtp2.invalid.test',
    '把遮罩送回來時不會把原本的密碼洗掉');

  const smtpTest = await call('POST', '/notifications/smtp/test', { to: 'nobody@invalid.test' }, adm);
  ok(smtpTest.status === 502 && /寄不出去/.test(smtpTest.data.error || ''),
    '寄不出去時給的是看得懂的中文錯誤');
  const smtpTestTea = await call('POST', '/notifications/smtp/test', { to: 'x@y.z' }, tea);
  ok(smtpTestTea.status === 403, '老師不能亂寄測試信');

  await call('PUT', '/notifications/smtp', {
    smtp: { enabled: false, host: '', user: '', pass: '', from: '' },
  }, adm);
  ok((await call('GET', '/notifications/smtp', null, adm)).data.smtp.active === false, '測完把設定清乾淨');

  // ── 穩定性防線 ──────────────────────────────────────────
  console.log('\n穩定性');
  const hStart = Date.now();
  const h2 = await call('GET', '/health');
  ok(h2.status === 200 && Date.now() - hStart < 4000,
    `健康檢查有逾時保護，${Date.now() - hStart} ms 內回應`);

  // 負數 / 超大 / 非數字的 limit 都不能讓伺服器噴 500
  for (const bad of ['-1', '0', 'abc', '999999999', '1e99']) {
    const r = await call('GET', `/practice/wrong?limit=${bad}`, null, stu);
    ok(r.status === 200, `limit=${bad} 不會造成 500（回 ${r.status}）`);
  }
  const badMg = await call('GET', '/manage/results?limit=-5', null, tea);
  ok(badMg.status === 200, '成績清單的 limit=-5 也擋得住');

  // 速率限制留到最後再測，否則會把後面的測試一起擋掉

  // 卡住的批改要撿得回來
  const stuckId = (await call('GET', '/exam/my-attempts', null, stu)).data.attempts[0]?.id;
  if (stuckId) {
    const before = (await call('GET', `/results/${stuckId}`, null, tea)).data;
    ok(before.result?.status === 'graded' || before.attempt?.status === 'graded',
      '既有成績仍然是已完成狀態');
  } else {
    ok(true, '（沒有可用場次，略過卡住批改檢查）');
  }

  // ── 題目編輯器 ──────────────────────────────────────────
  console.log('\n題目編輯器');
  const edPaper = {
    title: `編輯測試 ${stamp}`, testType: 'academic',
    modules: [{ module: 'reading', sections: [{
      title: 'Reading Passage 1', passage: '<p>Bees matter.</p>',
      groups: [{ type: 'tfng', instructions: 'TFNG', questions: [
        { number: 1, text: '第一題', answers: ['TRUE'], explanation: '第一段' },
        { number: 2, text: '第二題', answers: ['FALSE'] },
      ] }],
    }] }],
  };
  const edMade = await call('POST', '/tests', { paper: edPaper }, tea);
  const edId = edMade.data.id;
  ok(edId > 0, '建立要編輯的試卷');

  const edLoaded = await call('GET', `/tests/${edId}`, null, tea);
  ok(edLoaded.data.paper.modules[0].sections[0].groups[0].questions.length === 2,
    '編輯器讀得到完整題目（含答案與解析）');
  ok(!!edLoaded.data.paper.modules[0].sections[0].groups[0].questions[0].explanation,
    '解析也讀得到');

  // 改題幹與答案
  const edited = JSON.parse(JSON.stringify(edLoaded.data.paper));
  edited.modules[0].sections[0].groups[0].questions[0].text = '改過的題幹';
  edited.modules[0].sections[0].groups[0].questions[0].answers = ['NOT GIVEN'];
  edited.modules[0].sections[0].groups[0].questions.push({
    number: 3, text: '新增的題目', answers: ['TRUE'],
  });
  const edSave = await call('PUT', `/tests/${edId}`, { paper: edited }, tea);
  ok(edSave.status === 200 && edSave.data.stats.reading === 3, '存得回去，題數變成 3');

  const edBack = (await call('GET', `/tests/${edId}`, null, tea)).data.paper;
  const edQs = edBack.modules[0].sections[0].groups[0].questions;
  ok(edQs[0].text === '改過的題幹' && edQs[0].answers[0] === 'NOT GIVEN', '題幹與答案真的改掉了');

  // 驗證要擋得住壞資料
  const edDup = JSON.parse(JSON.stringify(edBack));
  edDup.modules[0].sections[0].groups[0].questions[2].number = 1;
  const vDup = await call('POST', '/tests/validate', { paper: edDup }, tea);
  ok(vDup.data.ok === false && vDup.data.errors.some((e) => /重複/.test(e)), '題號重複會被驗證擋下');

  const edNoAns = JSON.parse(JSON.stringify(edBack));
  edNoAns.modules[0].sections[0].groups[0].questions[0].answers = [];
  const vNoAns = await call('POST', '/tests/validate', { paper: edNoAns }, tea);
  ok(vNoAns.data.ok === false && vNoAns.data.errors.some((e) => /沒有標準答案/.test(e)),
    '沒填答案會被驗證擋下');

  const edBadEnum = JSON.parse(JSON.stringify(edBack));
  edBadEnum.modules[0].sections[0].groups[0].questions[0].answers = ['MAYBE'];
  const vBadEnum = await call('POST', '/tests/validate', { paper: edBadEnum }, tea);
  ok(vBadEnum.data.ok === false, 'T/F/NG 填了不合法的答案會被擋下');

  const edStu = await call('GET', `/tests/${edId}`, null, stu);
  ok(edStu.status === 403, '學生開不了編輯器用的 API（會看到答案）');
  const edSaveStu = await call('PUT', `/tests/${edId}`, { paper: edited }, stu);
  ok(edSaveStu.status === 403, '學生不能改題目');

  await call('DELETE', `/tests/${edId}`, null, adm);

  // ── 錯題複習與口說練習 ──────────────────────────────────
  console.log('\n錯題複習與練習');
  const wrong = await call('GET', '/practice/wrong', null, stu);
  ok(wrong.status === 200 && Array.isArray(wrong.data.items), '錯題清單讀得到');
  ok(wrong.data.total >= 5, `抓到 ${wrong.data.total} 題錯題（測試時故意留白 5 題閱讀）`);
  const wItem = wrong.data.items[0];
  ok(wItem && wItem.text && wItem.expected, '錯題帶回題幹與正確答案');
  ok(wItem && !/^\[/.test(wItem.expected), `正解是給人看的格式：${wItem?.expected}`);
  ok(wrong.data.byType.length > 0 && wrong.data.byType[0].wrong > 0,
    `依題型統計錯幾題：${wrong.data.byType.map((t) => `${t.type} ${t.wrong}`).join('、')}`);

  const wFiltered = await call('GET', '/practice/wrong?module=reading', null, stu);
  ok(wFiltered.data.items.every((i) => i.module === 'reading'), '可以只看某一科的錯題');
  const wNone = await call('GET', '/practice/wrong?module=writing', null, stu);
  ok(wNone.data.items.length === 0, '寫作沒有逐題對錯，不會出現在錯題本');

  // 重做：不能夾帶答案
  const drill = await call('POST', '/practice/drill', { count: 5 }, stu);
  ok(drill.data.items?.length > 0, `抽到 ${drill.data.items?.length} 題可以重做`);
  const drillJson = JSON.stringify(drill.data);
  ok(!drillJson.includes('"answers"') && !drillJson.includes('"expected"')
     && !drillJson.includes('"explanation"'),
    '重做的題目不含答案與解析（不然練了也沒意義）');

  const answersMap = {};
  for (const it of drill.data.items) answersMap[it.key] = 'TRUE';
  const checked = await call('POST', '/practice/drill/check', { responses: answersMap }, stu);
  ok(checked.data.total === drill.data.items.length, '重做交卷後每一題都有批改');
  ok(checked.data.results.every((r) => 'correct' in r && 'expected' in r),
    '批改結果帶回對錯與正解');
  ok(typeof checked.data.correct === 'number', `這次答對 ${checked.data.correct}/${checked.data.total}`);

  // 練習不會產生成績
  const beforeAttempts = (await call('GET', '/exam/my-attempts', null, stu)).data.attempts.length;
  await call('POST', '/practice/drill/check', { responses: answersMap }, stu);
  const afterAttempts = (await call('GET', '/exam/my-attempts', null, stu)).data.attempts.length;
  ok(beforeAttempts === afterAttempts, '練習不會多出一筆考試紀錄');

  // 學生只能看自己的
  const spy = await call('GET', `/practice/wrong?userId=${me.data.user.id}`, null,
    (await call('POST', '/auth/login', { username: 'student3', password: 'ielts1234' })).data.token);
  ok(spy.status === 200 && spy.data.total === 0, '學生指定別人的 userId 也只會拿到自己的錯題');

  // 口說練習出題
  const spQ = await call('POST', '/practice/speaking/question', { part: 2 }, stu);
  ok(spQ.status === 200 && spQ.data.question, `口說出得了題（來源：${spQ.data.source}）`);
  ok(spQ.data.part === 2, '出的是指定的 Part');
  const spQ1 = await call('POST', '/practice/speaking/question', { part: 1 }, stu);
  ok(spQ1.data.part === 1, 'Part 1 也出得了題');
  const spBad = await call('POST', '/practice/speaking/grade', { part: 1, question: 'x' }, stu);
  ok(spBad.status === 400 && /沒有收到|逐字稿/.test(spBad.data.error || ''),
    '沒有作答內容時給得出看得懂的訊息');

  // ── 螢光筆與註記要留得住 ────────────────────────────────
  console.log('\n螢光筆與註記');
  const marks = {
    'reading:0:passage': [
      { hid: 1, start: 18, end: 58, note: null },
      { hid: 2, start: 120, end: 160, note: '這裡是關鍵句' },
    ],
    'reading:0:questions': [{ hid: 3, start: 5, end: 30, note: null }],
    'listening:1:questions': [{ hid: 4, start: 0, end: 12, note: '注意數字' }],
  };
  const saveMk = await call('POST', `/exam/${attemptId}/state`, { ui: { marks } }, stu);
  ok(saveMk.status === 200, '畫記可以存到伺服器');

  const reloadMk = await call('GET', `/exam/${attemptId}`, null, stu);
  const mkBack = reloadMk.data.state?.ui?.marks;
  ok(!!mkBack, '重新載入考卷時拿得回畫記');
  ok(mkBack?.['reading:0:passage']?.length === 2, '同一段落的多筆畫記都在');
  ok(mkBack?.['reading:0:passage']?.[1]?.note === '這裡是關鍵句', '註記文字完整保留');
  ok(mkBack?.['reading:0:questions']?.length === 1 && mkBack?.['listening:1:questions']?.length === 1,
    '題目區與其他科目的畫記各自獨立');
  ok(mkBack?.['listening:1:questions']?.[0]?.start === 0, '位移是數字，重畫時才塗得回原位');

  // 畫記是位移，不含題目原文，所以不會夾帶答案
  ok(!JSON.stringify(mkBack).includes('answers'), '畫記資料不含任何答案欄位');

  const otherStu = await call('POST', '/auth/login', { username: 'student2', password: 'ielts1234' });
  if (otherStu.data.token) {
    const peek = await call('GET', `/exam/${attemptId}`, null, otherStu.data.token);
    ok(peek.status === 403, '別的學生看不到這場考試的畫記');
  } else {
    ok(true, '（沒有 student2，略過跨學生檢查）');
  }

  // 清空
  await call('POST', `/exam/${attemptId}/state`, { ui: { marks: {} } }, stu);
  const cleared = await call('GET', `/exam/${attemptId}`, null, stu);
  ok(Object.keys(cleared.data.state?.ui?.marks || {}).length === 0, '可以整批清掉畫記');

  // ── 素材（文章／音檔／圖片）不能在路上掉光 ──────────────
  console.log('\n素材保全');
  const MEDIA_PAPER = {
    title: `素材測試 ${stamp}`,
    testType: 'academic',
    modules: [
      { module: 'listening', sections: [{
        title: 'Section 1',
        audio: '/uploads/audio/t.mp3',
        transcript: 'Speaker A: hello.',
        image: '/uploads/image/sec.png',
        groups: [{
          type: 'label_image', instructions: 'Label the map.',
          image: '/uploads/image/grp.png',
          options: [{ key: 'A', text: 'Gate' }, { key: 'B', text: 'Hall' }],
          questions: [{ number: 1, text: 'Entrance', answers: ['A'], image: '/uploads/image/q.png' }],
        }],
      }] },
      { module: 'reading', sections: [{
        title: 'Reading Passage 1',
        passageTitle: 'The Urban Beehive',
        source: 'Adapted from Nature',
        passage: '<p>Bees matter.</p><figure><img src="/uploads/image/bee.png" alt="bee"></figure>',
        groups: [{
          type: 'tfng', instructions: 'TRUE/FALSE/NOT GIVEN',
          image: '/uploads/image/fig.png',
          questions: [{ number: 1, text: 'Bees matter.', answers: ['TRUE'] }],
        }],
      }] },
      { module: 'writing', sections: [{
        title: 'Writing',
        groups: [{ type: 'writing_task', questions: [
          { number: 1, taskNo: 1, minWords: 150, text: 'Describe the chart.',
            image: '/uploads/image/chart.png', visualDescription: 'A bar chart.', answers: [] },
        ] }],
      }] },
    ],
  };

  const mkTest = await call('POST', '/tests', { paper: MEDIA_PAPER, published: true }, tea);
  const mediaTestId = mkTest.data.id;
  ok(mediaTestId > 0, '建立含完整素材的試卷');

  const savedPaper = (await call('GET', `/tests/${mediaTestId}`, null, tea)).data.paper;
  const mkR = savedPaper.modules.find((m) => m.module === 'reading').sections[0];
  const mkL = savedPaper.modules.find((m) => m.module === 'listening').sections[0];
  ok(!!mkR.passage && /<img/.test(mkR.passage), '存進資料庫後文章與文章內的圖片都還在');
  ok(!!mkR.passageTitle && !!mkR.source, '文章標題與出處都在');
  ok(!!mkL.audio && !!mkL.image && !!mkL.groups[0].image && !!mkL.groups[0].questions[0].image,
    '音檔、節圖片、題組圖片、單題圖片都在');

  const mAsg = await call('POST', '/tests/assignments', {
    testId: mediaTestId, userIds: [me.data.user.id], modules: 'listening,reading,writing',
  }, tea);
  const mAsgId = (mAsg.data.ids || [])[0];
  ok(Number.isInteger(mAsgId), `指派給學生（assignment #${mAsgId}）`);
  const mStart = await call('POST', '/exam/start', { assignmentId: mAsgId, testId: mediaTestId }, stu);
  const mAttempt = mStart.data.attemptId;
  const sPaper = (await call('GET', `/exam/${mAttempt}`, null, stu)).data.paper;
  const sR = sPaper.modules.find((m) => m.module === 'reading').sections[0];
  const sL = sPaper.modules.find((m) => m.module === 'listening').sections[0];
  const sW = sPaper.modules.find((m) => m.module === 'writing').sections[0].groups[0].questions[0];
  ok(!!sR.passage && /<img/.test(sR.passage), '學生拿到的考卷有文章，文章內的圖片也在');
  ok(!!sR.passageTitle && !!sR.source, '學生看得到文章標題與出處');
  ok(!!sR.groups[0].image, '學生看得到閱讀題組的圖片');
  ok(!!sL.audio, '學生拿得到聽力音檔網址');
  ok(!!sL.image && !!sL.groups[0].image && !!sL.groups[0].questions[0].image, '聽力的三層圖片都在');
  ok(!!sW.image && !!sW.visualDescription, '寫作 Task 1 的圖表與圖表說明都在');
  ok(!sL.transcript, '逐字稿仍然不給學生（考試中不能看）');
  ok(!sR.groups[0].questions[0].answers, '答案仍然不給學生');

  // 缺素材要被抓出來，不能默默存進去
  const holed = await call('POST', '/tests', {
    paper: {
      title: `缺素材 ${stamp}`, testType: 'academic',
      modules: [
        { module: 'reading', sections: [{ title: 'RP1', groups: [{ type: 'tfng', questions: [{ number: 1, text: 'x', answers: ['TRUE'] }] }] }] },
        { module: 'listening', sections: [{ title: 'S1', groups: [{ type: 'short_answer', wordLimit: 1, questions: [{ number: 1, text: 'y', answers: ['yes'] }] }] }] },
      ],
    },
  }, tea);
  ok((holed.data.warnings || []).some((w) => /沒有 passage/.test(w)), '閱讀缺文章會被警告');
  ok((holed.data.warnings || []).some((w) => /沒有指定 audio/.test(w)), '聽力缺音檔會被警告');

  const mediaList = await call('GET', '/tests', null, tea);
  const holedRow = mediaList.data.tests.find((t) => t.id === holed.data.id);
  ok(holedRow && holedRow.missingMedia === 2, '試卷清單直接標出缺 2 節素材');
  const goodRow = mediaList.data.tests.find((t) => t.id === mediaTestId);
  ok(goodRow && goodRow.missingMedia === 0, '素材齊全的試卷不會被誤標');
  ok(!('content' in (holedRow || {})), '清單不夾帶整份試卷內容');

  // 純文字文章要自動分段，不能整篇擠成一坨
  const plainText = await call('POST', '/tests', {
    paper: {
      title: `純文字 ${stamp}`, testType: 'academic',
      modules: [{ module: 'reading', sections: [{
        title: 'RP1', passage: '第一段。\n\n第二段。',
        groups: [{ type: 'tfng', questions: [{ number: 1, text: 'x', answers: ['TRUE'] }] }],
      }] }],
    },
  }, tea);
  const plainBack = (await call('GET', `/tests/${plainText.data.id}`, null, tea)).data.paper;
  const plainPassage = plainBack.modules[0].sections[0].passage;
  ok(/<p>第一段。<\/p><p>第二段。<\/p>/.test(plainPassage), '貼純文字會自動補成段落');

  // 收尾。刪不掉不該讓整個測試掛掉，但要講出來
  const cleanup = [
    ['刪成績', () => call('POST', '/manage/results/bulk', { action: 'delete', ids: [mAttempt], force: true }, adm)],
    ['刪指派', () => call('DELETE', `/tests/assignments/${mAsgId}`, null, adm)],
    ['刪試卷', () => call('DELETE', `/tests/${mediaTestId}`, null, adm)],
    ['刪缺素材試卷', () => call('DELETE', `/tests/${holed.data.id}`, null, adm)],
    ['刪純文字試卷', () => call('DELETE', `/tests/${plainText.data.id}`, null, adm)],
  ];
  const stuck = [];
  for (const [label, fn] of cleanup) {
    const r = await fn().catch((e) => ({ status: 0, data: { error: e.message } }));
    if (r.timedOut || r.status === 0 || r.status >= 500) {
      stuck.push(`${label}(${r.status}: ${r.data?.error || ''})`);
    }
  }
  ok(stuck.length === 0, stuck.length ? `收尾卡住：${stuck.join('、')}` : '素材測試資料收尾完成');

  // 亂七八糟的 id 要回 400，不能變成 500
  const badId = await call('DELETE', '/tests/assignments/undefined', null, adm);
  ok(badId.status === 400, '非數字的指派編號回 400，不會噴 500');
  const goneId = await call('DELETE', '/tests/assignments/999999', null, adm);
  ok(goneId.status === 404, '不存在的指派回 404');

  // ── AI 背景工作（整份試卷產生）─────────────────────────
  console.log('\nAI 背景工作');
  const jobStart = Date.now();
  const jStart = await call('POST', '/ai/generate-paper', { testType: 'academic', theme: `e2e ${stamp}` }, tea);
  const jobMs = Date.now() - jobStart;
  ok(jStart.status === 202 && jStart.data.jobId > 0,
    `建立工作立刻回應（${jobMs} ms，不再卡住整個請求）`);
  ok(jobMs < 5000, '回應時間遠低於任何反向代理的逾時');
  const jobId = jStart.data.jobId;

  // 沒設 AI 金鑰時第一個工作會在幾毫秒內就失敗，所以不能假設它還在跑 ——
  // 直接照回應驗真正的規則：同一個人「同時」只能有一個進行中的工作。
  const jDup = await call('POST', '/ai/generate-paper', { testType: 'academic' }, tea);
  if (jDup.status === 409) {
    ok(jDup.data.jobId === jobId, '前一個還在跑時開第二份會被擋下，並帶回進行中的 jobId');
  } else {
    const prev = (await call('GET', `/ai/jobs/${jobId}`, null, tea)).data.job;
    ok(jDup.status === 202 && ['done', 'error', 'cancelled'].includes(prev.status),
      `前一個工作已經結束（${prev?.status}）才放行第二份`);
    if (jDup.data.jobId) await call('POST', `/ai/jobs/${jDup.data.jobId}/cancel`, {}, tea);
  }

  const jList = await call('GET', '/ai/jobs?kind=generate_paper', null, tea);
  ok(jList.data.jobs.some((j) => j.id === jobId), '工作出現在自己的清單裡');
  ok(!('result' in (jList.data.jobs[0] || { result: 1 })), '清單不夾帶整包結果');

  const jGet = await call('GET', `/ai/jobs/${jobId}`, null, tea);
  ok(jGet.status === 200 && jGet.data.job.totalSteps === 9, '可以查到進度，共 9 個步驟');
  ok(typeof jGet.data.job.percent === 'number', '有百分比可以畫進度條');

  const jStu = await call('GET', `/ai/jobs/${jobId}`, null, stu);
  ok(jStu.status === 403, '學生看不到 AI 工作');
  const jOther = await call('GET', `/ai/jobs/${jobId}`, null, adm);
  ok(jOther.status === 200, '管理員看得到別人的工作');
  const jMissing = await call('GET', '/ai/jobs/999999', null, tea);
  ok(jMissing.status === 404, '不存在的工作回 404');

  // 沒設定 AI 金鑰時應該立刻失敗，而不是重試 18 次
  let jFinal = null;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    jFinal = (await call('GET', `/ai/jobs/${jobId}`, null, tea)).data.job;
    if (['done', 'error', 'cancelled'].includes(jFinal.status)) break;
  }
  if (jFinal && jFinal.status === 'error') {
    ok(!/operation was aborted/i.test(jFinal.error || ''),
      '失敗訊息不會是看不懂的英文 abort');
    ok(/設定|金鑰|API Key|端點|逾時/.test(jFinal.error || ''),
      `失敗訊息說得出原因：${(jFinal.error || '').slice(0, 40)}…`);
  } else {
    // CI 上真的有設金鑰時就跑得完，那也算通過
    ok(['done', 'running', 'cancelled'].includes(jFinal?.status),
      `工作狀態合理：${jFinal?.status}`);
  }

  const jCancel = await call('POST', `/ai/jobs/${jobId}/cancel`, {}, tea);
  ok(jCancel.status === 200, '可以取消工作');
  const jCancelStu = await call('POST', `/ai/jobs/${jobId}/cancel`, {}, stu);
  ok(jCancelStu.status === 403, '學生不能取消別人的工作');

  // ── 出題難度 ────────────────────────────────────────────
  console.log('\n出題難度');
  const dfCfg = await call('GET', '/ai/difficulty', null, tea);
  ok(dfCfg.status === 200 && Object.keys(dfCfg.data.levels).length === 5, '五檔難度讀得到');
  ok(dfCfg.data.defaultLevel === 'band 6-7', '預設是官方一般難度');
  ok(Object.keys(dfCfg.data.knobs).length === 4, '四個進階微調項目');
  ok(/文章 800–950 字/.test(dfCfg.data.describe.reading || ''), '中文說明講得出具體字數');
  const dfStu = await call('GET', '/ai/difficulty', null, stu);
  ok(dfStu.status === 403, '學生看不到出題難度設定');

  const dfMix = await call('GET', `/ai/difficulty?${new URLSearchParams({
    level: 'band 7-8',
    perModule: JSON.stringify({ listening: 'band 4-5' }),
    knobs: JSON.stringify({ vocab: 'common' }),
  })}`, null, tea);
  ok(dfMix.data.resolved.modules.listening.level === 'band 4-5'
    && dfMix.data.resolved.modules.listening.overridden === true, '單科覆寫生效');
  ok(dfMix.data.resolved.modules.reading.level === 'band 7-8'
    && dfMix.data.resolved.modules.reading.overridden === false, '沒覆寫的科目維持整體難度');
  ok(dfMix.data.resolved.modules.reading.knobs.vocab === 'common', '進階微調套用到每一科');
  ok(/500–650 字/.test(dfMix.data.describe.listening || ''), '覆寫後的說明跟著變');

  const dfJunk = await call('GET', `/ai/difficulty?${new URLSearchParams({
    level: '<script>alert(1)</script>', perModule: 'not-json', knobs: '{"vocab":"; DROP TABLE"}',
  })}`, null, tea);
  ok(dfJunk.status === 200 && dfJunk.data.resolved.level === 'band 6-7', '亂送參數退回預設，不會 500');
  ok(dfJunk.data.resolved.knobs.vocab === 'auto', '不認得的微調值退回 auto');

  // 難度要真的跟著背景工作走，重新整理頁面接回時才看得到當初選了什麼
  const dfJob = await call('POST', '/ai/generate-paper', {
    testType: 'academic', theme: `難度測試 ${stamp}`,
    difficulty: { level: 'band 8-9', perModule: { listening: 'band 4-5' }, knobs: { vocab: 'common' } },
  }, adm);
  if (dfJob.status === 202) {
    const j = await call('GET', `/ai/jobs/${dfJob.data.jobId}`, null, adm);
    const p = j.data.job.params || {};
    ok(p.difficulty?.level === 'band 8-9', '難度存進背景工作的參數裡');
    ok(p.difficulty?.modules?.listening?.level === 'band 4-5', '單科覆寫也存下來了');
    await call('POST', `/ai/jobs/${dfJob.data.jobId}/cancel`, {}, adm);
  } else {
    ok(dfJob.status === 409, `已有工作在跑，略過（${dfJob.status}）`);
  }

  // ── 考前環境診斷 ────────────────────────────────────────
  console.log('\n考前環境診斷');
  const dcCfg = await call('GET', '/check/config');
  ok(dcCfg.status === 200 && !!dcCfg.data.checks.mic, '設定不用登入就讀得到');
  ok(dcCfg.data.checks.mic.critical === true, '麥克風被標成必要項目');
  ok(typeof dcCfg.data.serverTime === 'number', '有回傳伺服器時間讓學生校時');

  const dcAnon = await call('POST', '/check', {
    results: { mic: { status: 'pass' }, secure: { status: 'pass' }, server: { status: 'pass' } },
  });
  ok(dcAnon.status === 200 && dcAnon.data.ok === true, '未登入也存得進去');
  ok(/^[2-9A-Z]{6}$/.test(dcAnon.data.code || ''), `會給一組診斷碼（${dcAnon.data.code}）`);

  const dcBad = await call('POST', '/check', {
    results: { mic: { status: 'fail', note: '權限被拒' }, secure: { status: 'pass' } },
  });
  ok(dcBad.data.ok === false && dcBad.data.criticalFails.includes('麥克風'),
    '必要項目沒過會單獨點名');

  // 這支是全站唯一不用登入就能寫入的端點，亂送東西不能把它打掛
  const dcJunk = await call('POST', '/check', {
    results: { mic: { status: '<script>x</script>', note: 'A'.repeat(5000) }, 亂碼: 1 },
  });
  ok(dcJunk.status === 200, '亂送資料不會 500');
  const dcTok = await call('POST', '/check', { results: { mic: { status: 'pass' } } }, 'not.a.real.token');
  ok(dcTok.status === 200, 'token 壞掉時當成未登入，不會讓學生測不了');

  const dcMine = await call('POST', '/check', { results: { mic: { status: 'pass' } } }, stu);
  ok(dcMine.status === 200, '登入後回報會綁到帳號');
  const dcList = await call('GET', '/check/list?limit=20', null, tea);
  ok(dcList.status === 200 && dcList.data.items.length > 0, '老師看得到誰測過');
  ok(dcList.data.items.some((x) => x.username === 'student1'), '認得出是哪個學生測的');
  ok(!JSON.stringify(dcList.data).includes('<script>'), '存進去的狀態是正規化過的');
  const dcStu = await call('GET', '/check/list', null, stu);
  ok(dcStu.status === 403, '學生看不到別人的檢查紀錄');

  // ── 紀律事件分級 ────────────────────────────────────────
  console.log('\n紀律事件分級');
  const cdTest = await call('POST', '/tests', {
    paper: normalizePaper({
      title: `分級測試 ${stamp}`, testType: 'academic',
      modules: [
        { module: 'reading', sections: [{ title: 'Passage 1', passage: 'Text.', groups: [bankGroup(3, 1)] }] },
        { module: 'speaking', sections: [{ title: 'Speaking', groups: [{
          type: 'speaking_part',
          questions: [{ number: 1, part: 1, prompt: 'Tell me about your hometown.' }],
        }] }] },
      ],
    }),
  }, tea);
  const cdAssign = await call('POST', '/tests/assignments', {
    testId: cdTest.data.id, userIds: [stuUid], modules: 'reading,speaking', maxAttempts: 9,
    proctoring: { enabled: true, requireFullscreen: true, warnOnLeave: true, maxLeaves: 0, onExceed: 'warn' },
  }, tea);
  const cdAvail = (await call('GET', '/exam/available', null, stu)).data.available
    .find((x) => x.assignmentId === cdAssign.data.ids[0]);
  const cdStart = await call('POST', '/exam/start',
    { assignmentId: cdAvail.assignmentId, testId: cdAvail.testId }, stu);
  const cdId = cdStart.data.attemptId;
  ok(cdId > 0, '開始一場有監考的考試');
  await call('POST', `/exam/${cdId}/module/start`, { module: 'reading' }, stu);

  const cdEv = async (type, module, detail) =>
    (await call('POST', `/exam/${cdId}/event`, { type, module, detail }, stu)).data;

  const cd1 = await cdEv('fullscreen_exit', 'reading', '離開全螢幕');
  ok(cd1.severity === 'warn' && cd1.leaveCount === 1, '閱讀離開全螢幕算違規，計入次數');

  const cd2 = await cdEv('fullscreen_exit', 'speaking', '離開全螢幕');
  ok(cd2.severity === 'info' && cd2.excused === true,
    '口說離開全螢幕不算違規（這一科本來就沒要求全螢幕）');
  ok(cd2.leaveCount === 1, '而且不會把離開次數加上去');

  const cd3 = await cdEv('device_permission', 'speaking', '瀏覽器擋住了麥克風');
  ok(cd3.severity === 'info', '回報裝置問題本身不是違規');
  const cd4 = await cdEv('leave', 'speaking', '離開考試視窗');
  ok(cd4.severity === 'info' && /裝置權限/.test(cd4.reason || ''),
    '緊接著去改瀏覽器設定的離開被判成處理裝置權限');
  ok(cd4.leaveCount === 1, '學生不會因為系統自己造成的中斷而被扣點');

  const cd5 = await cdEv('copy_blocked', 'reading', '嘗試複製');
  ok(cd5.severity === 'alert', '嘗試複製題目是可疑等級');
  ok(cd5.leaveCount === 1, '可疑事件不算進「離開次數」');

  const cdEvents = await call('GET', `/exam/${cdId}/events`, null, tea);
  ok(cdEvents.data.events.every((e) => !!e.severity), '每一筆事件都有等級');
  const cdBadType = await call('POST', `/exam/${cdId}/event`, { type: 'nonsense' }, stu);
  ok(cdBadType.status === 400, '沒見過的事件類型會被擋下');

  await call('POST', `/exam/${cdId}/submit`, {}, stu);
  const cdRes = await call('GET', `/results/${cdId}`, null, tea);
  ok(cdRes.data.conduct.leaveCount === 1, `成績頁只算真正的離開（${cdRes.data.conduct.leaveCount} 次）`);
  ok(cdRes.data.conduct.excusedCount === 2,
    `裝置問題造成的 ${cdRes.data.conduct.excusedCount} 次另外列，不跟作弊混在一起`);
  ok(cdRes.data.conduct.bySeverity.alert === 1, '成績頁看得到各等級的數量');
  const cdResStu = await call('GET', `/results/${cdId}`, null, stu);
  ok(cdResStu.data.conduct.events.length === 0, '學生看不到事件明細');

  await call('DELETE', `/tests/assignments/${cdAssign.data.ids[0]}`, null, tea);
  await call('POST', '/manage/results/bulk', { action: 'delete', ids: [cdId], force: true }, adm);
  await call('DELETE', `/tests/${cdTest.data.id}`, null, adm);

  // ── 人機驗證設定 ───────────────────────────────────────
  console.log('\n人機驗證');
  const tsPub = await call('GET', '/auth/config');
  ok(tsPub.status === 200 && typeof tsPub.data.turnstile.enabled === 'boolean',
    '登入頁可讀取公開的 Turnstile 設定');
  ok(!('secretKey' in tsPub.data.turnstile), '公開設定絕對不含 Secret Key');
  const tsAdmin = await call('GET', '/manage/turnstile', null, tea);
  ok(tsAdmin.status === 200 && !/^0x[0-9a-zA-Z]{20,}$/.test(tsAdmin.data.turnstile.secretKey || ''),
    '後台讀到的 Secret Key 是遮罩過的');
  const tsSave = await call('PUT', '/manage/turnstile', { turnstile: { enabled: false } }, tea);
  ok(tsSave.status === 403, '老師不能改人機驗證設定');
  const loginNoToken = await call('POST', '/auth/login', { username: 'student1', password: 'ielts1234' });
  ok(loginNoToken.status === 200, '人機驗證關閉時，沒有 token 也能正常登入');

  // ── 速率限制（放最後，因為會把額度用光）──────────────────
  console.log('\n速率限制');
  let hit429 = false;
  for (let i = 0; i < 12; i += 1) {
    const r = await call('POST', '/ai/grade-writing', { essay: 'x'.repeat(60), prompt: 'p' }, stu);
    if (r.status === 429) { hit429 = true; break; }
  }
  ok(hit429, 'AI 批改端點連打會回 429（沒有的話 API 額度會被燒光）');
  const limited = await call('POST', '/ai/grade-writing', { essay: 'x'.repeat(60) }, stu);
  ok(limited.status === 429 && limited.data.retryAfter > 0,
    `429 會告訴你要等幾秒（${limited.data.retryAfter}）`);

  console.log(`\n${'─'.repeat(46)}`);
  console.log(`通過 ${pass}　失敗 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n測試中斷：', e); process.exit(1); });
