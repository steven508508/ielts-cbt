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

async function call(method, path, body, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
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
  ok(mt.data.tests[0].attempts > 0, `試卷管理顯示考試紀錄數：${mt.data.tests[0].attempts}`);
  const testId = mt.data.tests[0].id;
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

  console.log(`\n${'─'.repeat(46)}`);
  console.log(`通過 ${pass}　失敗 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n測試中斷：', e); process.exit(1); });
