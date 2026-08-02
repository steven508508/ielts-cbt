'use strict';
/* 班級隔離的實測。
 *
 * 跟 test/security.js 一樣，不看程式碼、只發真實請求。
 * 建兩個班、兩位老師（各管一班）、一位不指定班級的老師（＝全校，
 * 例如科目負責人），然後逐一驗證每個入口有沒有真的擋住。
 *
 * 權限這種東西最怕「大部分入口有擋、漏了一個」—— 漏掉的那一個
 * 從畫面上完全看不出來。
 *
 *   node test/scope.js
 */
const B = process.env.BASE || 'http://localhost:3000';
const db = require('../server/db');

let pass = 0; const fails = [];
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${extra ? `　${extra}` : ''}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${extra ? `　${extra}` : ''}`); }
};
async function call(method, path, body, token) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(`${B}/api${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json().catch(() => ({})) : await r.text() };
}
const login = async (username, password) => (await call('POST', '/auth/login', { username, password })).data;

const TAG = `zqx${Date.now().toString(36)}`;
const CLASS_A = `${TAG}甲`;
const CLASS_B = `${TAG}乙`;
const made = { users: [], tests: [], attempts: [] };

(async () => {
  const adm = await login('admin', 'admin1234');
  if (!adm.token) { console.error('管理員登入失敗'); process.exit(2); }

  console.log('\n── 佈置：兩個班、三位老師 ──');
  const mk = async (username, name, role, classGroup, manages) => {
    const r = await call('POST', '/users',
      { username, password: 'test1234', name, role, classGroup, manages }, adm.token);
    if (r.data.id) made.users.push(r.data.id);
    return r.data.id;
  };
  const stuA = await mk(`${TAG}sa`, '甲班學生', 'student', CLASS_A);
  const stuB = await mk(`${TAG}sb`, '乙班學生', 'student', CLASS_B);
  await mk(`${TAG}ta`, '甲班老師', 'teacher', null, [CLASS_A]);
  await mk(`${TAG}tb`, '乙班老師', 'teacher', null, [CLASS_B]);
  await mk(`${TAG}tall`, '科目負責人', 'teacher', null, []);      // 不指定 = 全校
  ok(!!stuA && !!stuB, '學生建好了');

  const tA = await login(`${TAG}ta`, 'test1234');
  const tB = await login(`${TAG}tb`, 'test1234');
  const tAll = await login(`${TAG}tall`, 'test1234');
  ok(!!tA.token && !!tB.token && !!tAll.token, '三位老師都登入得了');

  console.log('\n── ① 看得到哪些學生 ──');
  {
    const a = await call('GET', '/users', null, tA.token);
    const names = (a.data.users || []).map((u) => u.name);
    ok(names.includes('甲班學生'), '甲班老師看得到自己班的學生');
    ok(!names.includes('乙班學生'), '甲班老師看不到乙班的學生');
    ok(!(a.data.users || []).some((u) => u.role !== 'student'),
      '受限的老師看不到教職員名冊（含 email）');
    ok(Array.isArray(a.data.myClasses) && a.data.myClasses.includes(CLASS_A),
      '回應會告訴前端自己管哪些班', String(a.data.myClasses));

    const all = await call('GET', '/users', null, tAll.token);
    const allNames = (all.data.users || []).map((u) => u.name);
    ok(allNames.includes('甲班學生') && allNames.includes('乙班學生'),
      '不指定班級的老師（科目負責人）看得到全部');
    ok(all.data.myClasses === null, '全校範圍回 null');

    const cls = await call('GET', '/users/classes', null, tA.token);
    const clsNames = (cls.data.classes || []).map((c) => c.name);
    ok(clsNames.includes(CLASS_A) && !clsNames.includes(CLASS_B), '班級清單也只有自己的');
  }

  console.log('\n── ② 新增與編輯學生 ──');
  {
    const bad = await call('POST', '/users',
      { username: `${TAG}x1`, password: 'test1234', name: '偷加到乙班', role: 'student', classGroup: CLASS_B }, tA.token);
    ok(bad.status === 403, '甲班老師不能把學生加進乙班', `→ ${bad.status}`);

    const good = await call('POST', '/users',
      { username: `${TAG}x2`, password: 'test1234', name: '加到甲班', role: 'student', classGroup: CLASS_A }, tA.token);
    ok(good.status === 200, '加進自己班可以', `→ ${good.status}`);
    if (good.data.id) made.users.push(good.data.id);

    const edit = await call('PUT', `/users/${stuB}`, { name: '改別班的' }, tA.token);
    ok(edit.status === 403, '不能編輯別班的學生', `→ ${edit.status}`);

    const move = await call('PUT', `/users/${stuA}`, { classGroup: CLASS_B }, tA.token);
    ok(move.status === 403, '不能把自己班的學生搬到管不到的班', `→ ${move.status}`);

    const imp = await call('GET', `/users/${stuB}/impact`, null, tA.token);
    ok(imp.status === 403, '看不到別班學生的刪除影響', `→ ${imp.status}`);

    const bulk = await call('POST', '/users/bulk-action', { action: 'deactivate', ids: [stuA, stuB] }, tA.token);
    ok(bulk.status === 403, '批次動作只要有一位越界就整批拒絕（不能只做一半）', `→ ${bulk.status}`);

    const batch = await call('POST', '/users/bulk',
      { text: `越界的,${TAG}y1,pw123456,${CLASS_B}\n自己班的,${TAG}y2,pw123456,${CLASS_A}` }, tA.token);
    const createdNames = (batch.data.created || []).map((c) => c.name);
    ok(!createdNames.includes('越界的') && createdNames.includes('自己班的'),
      '批次建立會逐行檢查班級', `建立 ${createdNames.join('、')}`);
    for (const u of batch.data.created || []) {
      const row = await db.one('SELECT id FROM users WHERE username = ?', [u.username]);
      if (row) made.users.push(row.id);
    }
  }

  console.log('\n── ③ 指派考試 ──');
  let testId = null;
  {
    const t = await call('POST', '/tests', { paper: {
      title: `班級隔離測試 ${TAG}`, testType: 'academic',
      modules: [{ module: 'reading', durationSec: 3600, sections: [{ title: 'P1', passage: '<p>x</p>',
        groups: [{ type: 'tfng', instructions: 'i', questions: [{ number: 1, text: 'a', answers: ['TRUE'] }] }] }] }],
    } }, adm.token);
    testId = t.data.id;
    if (testId) made.tests.push(testId);

    const bad = await call('POST', '/tests/assignments',
      { testId, userIds: [stuB], modules: 'reading' }, tA.token);
    ok(bad.status === 403, '甲班老師不能指派給乙班學生', `→ ${bad.status}`);

    const badCls = await call('POST', '/tests/assignments',
      { testId, classGroup: CLASS_B, modules: 'reading' }, tA.token);
    ok(badCls.status === 403, '也不能整班指派給乙班', `→ ${badCls.status}`);

    const good = await call('POST', '/tests/assignments',
      { testId, userIds: [stuA], modules: 'reading', maxAttempts: 5 }, tA.token);
    ok(good.status === 200, '指派給自己班可以', `→ ${good.status}`);

    // 乙班老師指派給乙班，甲班老師不該看得到
    const gB = await call('POST', '/tests/assignments',
      { testId, userIds: [stuB], modules: 'reading', maxAttempts: 5 }, tB.token);
    ok(gB.status === 200, '乙班老師指派給乙班可以', `→ ${gB.status}`);

    const listA = await call('GET', '/tests/assignments/all', null, tA.token);
    const mineOnly = (listA.data.assignments || []).filter((a) => a.test_id === testId);
    ok(mineOnly.length === 1 && mineOnly[0].student_name === '甲班學生',
      '指派清單只看得到自己班的', `看到 ${mineOnly.length} 筆`);

    const bId = gB.data.ids?.[0];
    if (bId) {
      const del = await call('DELETE', `/tests/assignments/${bId}`, null, tA.token);
      ok(del.status === 403, '不能刪掉別班的指派', `→ ${del.status}`);
    }
  }

  console.log('\n── ④ 看與批改成績 ──');
  {
    const stuBLogin = await login(`${TAG}sb`, 'test1234');
    const avail = await call('GET', '/exam/available', null, stuBLogin.token);
    const av = (avail.data.available || []).find((x) => x.testId === testId);
    if (!av) { ok(false, '乙班學生拿得到指派'); }
    else {
      const st = await call('POST', '/exam/start', { assignmentId: av.assignmentId, testId }, stuBLogin.token);
      const at = st.data.attemptId;
      if (at) made.attempts.push(at);
      await call('POST', `/exam/${at}/submit`, {}, stuBLogin.token);

      const r = await call('GET', `/results/${at}`, null, tA.token);
      ok(r.status === 403, '甲班老師看不到乙班學生的成績', `→ ${r.status}`);
      const rb = await call('GET', `/results/${at}`, null, tB.token);
      ok(rb.status === 200, '乙班老師看得到', `→ ${rb.status}`);
      const rall = await call('GET', `/results/${at}`, null, tAll.token);
      ok(rall.status === 200, '科目負責人看得到全部', `→ ${rall.status}`);

      const g = await call('POST', `/results/${at}/grade`, { module: 'writing', band: 7 }, tA.token);
      ok(g.status === 403, '甲班老師不能替乙班學生改分數', `→ ${g.status}`);

      const rg = await call('POST', `/results/${at}/regrade`, {}, tA.token);
      ok(rg.status === 403, '也不能重跑批改', `→ ${rg.status}`);

      const sp = await call('GET', `/speaking/${at}/responses`, null, tA.token);
      ok(sp.status === 403, '拿不到別班學生的口說逐字稿與錄音路徑', `→ ${sp.status}`);

      const listA = await call('GET', '/results', null, tA.token);
      ok(!(listA.data.results || []).some((x) => x.id === at), '成績清單裡沒有別班的');
      const mgA = await call('GET', '/manage/results', null, tA.token);
      ok(!(mgA.data.results || mgA.data.items || []).some((x) => x.id === at), '資料管理的成績清單也沒有');

      const csv = await call('GET', '/manage/results/export.csv', null, tA.token);
      ok(!String(csv.data).includes('乙班學生'), '匯出的 CSV 不含別班學生');

      const bulk = await call('POST', '/manage/results/bulk', { action: 'archive', ids: [at] }, tA.token);
      const stillThere = await db.one('SELECT archived FROM attempts WHERE id = ?', [at]);
      ok(!Number(stillThere?.archived), '批次封存碰不到別班的場次', `archived=${stillThere?.archived}`);
      void bulk;
    }
  }

  console.log('\n── ⑤ 全站維護只給管理員 ──');
  for (const [m, p, b] of [
    ['GET', '/manage/overview', null],
    ['GET', '/manage/log', null],
    ['POST', '/manage/cleanup', { dryRun: true }],
    ['GET', `/manage/backup/test/${testId}.json`, null],
  ]) {
    const r = await call(m, p, b, tA.token);
    ok(r.status === 403, `老師打 ${m} ${p.replace(String(testId), ':id')} 被擋`, `→ ${r.status}`);
  }

  console.log('\n── ⑥ 只有管理員能設定老師的管轄班級 ──');
  {
    const tid = await db.one('SELECT id FROM users WHERE username = ?', [`${TAG}tb`]);
    const r = await call('PUT', `/users/${tid.id}`, { manages: [CLASS_A, CLASS_B] }, tA.token);
    ok(r.status === 403, '老師不能改別的老師（含管轄班級）', `→ ${r.status}`);
    const r2 = await call('PUT', `/users/${tid.id}`, { manages: [CLASS_A, CLASS_B] }, adm.token);
    ok(r2.status === 200, '管理員可以', `→ ${r2.status}`);
    const rows = await db.query('SELECT class_group FROM teacher_classes WHERE user_id = ?', [tid.id]);
    ok(rows.length === 2, '真的存進去了', rows.map((x) => x.class_group).join('、'));
    await call('PUT', `/users/${tid.id}`, { manages: [CLASS_B] }, adm.token);
  }

  // 收拾
  for (const at of made.attempts) await call('POST', '/manage/results/bulk', { action: 'delete', ids: [at], force: true }, adm.token);
  for (const t of made.tests) await call('DELETE', `/tests/${t}`, { force: true }, adm.token);
  for (const u of made.users) await call('DELETE', `/users/${u}`, null, adm.token);

  console.log('\n──────────────────────────────────────────────');
  console.log(`通過 ${pass}　失敗 ${fails.length}`);
  fails.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(fails.length ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    const adm = await login('admin', 'admin1234');
    for (const u of made.users) await call('DELETE', `/users/${u}`, null, adm.token);
    for (const t of made.tests) await call('DELETE', `/tests/${t}`, { force: true }, adm.token);
  } catch { /* 盡力而為 */ }
  process.exit(2);
});
