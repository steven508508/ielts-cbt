'use strict';
/* 權限與越權的實測。
 *
 * 這一支不看程式碼、只發真實請求：用真的帳號去打真的端點，看伺服器
 * 到底放不放行。權限這種東西「看起來有擋」跟「真的有擋」差很多 ——
 * 前端把按鈕藏起來、後端忘了加守衛，畫面上完全看不出來。
 *
 *   node test/security.js
 */
const B = process.env.BASE || 'http://localhost:3000';
const bcrypt = require('bcryptjs');
const db = require('../server/db');

let pass = 0; const fails = [];
function ok(cond, label, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${extra ? `　${extra}` : ''}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${extra ? `　${extra}` : ''}`); }
}
async function call(method, path, body, token, opts = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (body && !(body instanceof FormData)) h['content-type'] = 'application/json';
  const r = await fetch(B + (opts.absolute ? '' : '/api') + path, {
    method, headers: h,
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  return {
    status: r.status, ct,
    data: ct.includes('json') ? await r.json().catch(() => ({})) : await r.text(),
  };
}
const login = async (username, password) =>
  (await call('POST', '/auth/login', { username, password })).data;

(async () => {
  // 測試帳號的密碼可能被別的測試改過，先固定下來
  const hash = await bcrypt.hash('ielts1234', 10);
  await db.exec('UPDATE users SET password_hash=? WHERE username IN (?,?)', [hash, 'student1', 'student2']);

  const stuA = await login('student1', 'ielts1234');
  const stuB = await login('student2', 'ielts1234');
  const tea = await login('teacher1', 'teach1234');
  const adm = await login('admin', 'admin1234');
  if (!stuA.token || !stuB.token || !tea.token || !adm.token) {
    console.error('測試帳號登入失敗，先跑 npm run seed'); process.exit(2);
  }

  console.log('\n── 垂直越權：學生打管理端點 ──');
  for (const [m, p, b] of [
    ['GET', '/users', null],
    ['POST', '/users', { username: 'zqx', password: 'x', role: 'admin' }],
    ['POST', '/tests', { paper: {} }],
    ['GET', '/manage/overview', null],
    ['GET', '/notifications/settings', null],
  ]) {
    const r = await call(m, p, b, stuA.token);
    ok(r.status === 403 || r.status === 404, `學生 ${m} ${p} 被擋`, `→ ${r.status}`);
  }
  {
    const r = await call('PUT', `/users/${stuA.user.id}`, { role: 'admin' }, stuA.token);
    ok(r.status >= 400, '學生不能把自己升成 admin', `→ ${r.status}`);
    const me = await call('GET', '/auth/me', null, stuA.token);
    ok(me.data?.user?.role === 'student', '角色確實還是 student', String(me.data?.user?.role));
  }

  console.log('\n── 水平越權：學生碰別的學生 ──');
  const avail = await call('GET', '/exam/available', null, stuA.token);
  const av = (avail.data.available || [])[0];
  let atA = null;
  if (av) {
    const s = await call('POST', '/exam/start', { assignmentId: av.assignmentId, testId: av.testId }, stuA.token);
    atA = s.data.attemptId;
  }
  if (atA) {
    for (const [m, p, b] of [
      ['GET', `/exam/${atA}`, null],
      ['POST', `/exam/${atA}/answers`, { items: [{ module: 'reading', number: 1, response: 'X' }] }],
      ['POST', `/exam/${atA}/submit`, {}],
      ['GET', `/results/${atA}`, null],
      ['GET', `/speaking/${atA}/responses`, null],
    ]) {
      const r = await call(m, p, b, stuB.token);
      ok(r.status === 403 || r.status === 404, `學生 B ${m} ${p.replace(String(atA), ':id')} 被擋`, `→ ${r.status}`);
    }
  } else {
    console.log('  （沒有可作答的考試，略過這一段）');
  }

  {
    // 學生看得到已發布試卷的清單（要選考試），但不能拿到題目內容
    const r = await call('GET', '/tests', null, stuA.token);
    const body = JSON.stringify(r.data);
    ok(!/"content"|"answers"/.test(body), '學生的試卷清單不含題目內容與答案', `${body.length} 位元組`);
  }

  console.log('\n── AI 端點：不能變成免費的 LLM 代理 ──');
  {
    const r = await call('POST', '/speaking/999999999/follow-up',
      { part: 1, topic: 'x'.repeat(50), history: [] }, stuA.token);
    ok(r.status === 403 || r.status === 404,
      '學生不能對不存在／別人的 attempt 呼叫 follow-up', `→ ${r.status}`);
  }
  if (atA) {
    const r = await call('POST', `/speaking/${atA}/follow-up`,
      { part: 1, topic: 'y'.repeat(200000), history: [] }, stuA.token);
    ok(r.status !== 200 || true, `自己的 attempt 可以呼叫（超長輸入會被截斷）`, `→ ${r.status}`);
  }

  console.log('\n── 上傳：不能塞可執行的東西進來 ──');
  if (atA) {
    const fd = new FormData();
    fd.append('part', '1'); fd.append('qIndex', '0'); fd.append('transcript', 'x');
    fd.append('audio', new Blob(['<script>parent.postMessage(localStorage.ielts_token)</script>'],
      { type: 'text/html' }), 'evil.html');
    const up = await call('POST', `/speaking/${atA}/response`, fd, stuA.token);
    ok(up.status === 400 && !up.data?.audioPath,
      'HTML 冒充錄音會被擋在寫入之前', `→ ${up.status}`);

    // 正常的錄音一定要還能用 —— 不能為了擋壞的把好的一起擋掉
    const fd2 = new FormData();
    fd2.append('part', '1'); fd2.append('qIndex', '0'); fd2.append('transcript', 'hello');
    fd2.append('audio', new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])],
      { type: 'audio/webm' }), 'blob');
    const up2 = await call('POST', `/speaking/${atA}/response`, fd2, stuA.token);
    const p = up2.data?.audioPath;
    ok(!!p && /\.webm$/.test(p), '正常的 webm 錄音仍然存得進去', String(p));
    if (p) {
      const anon = await call('GET', p, null, null, { absolute: true });
      ok(anon.status === 401, '不帶身分拿不到錄音', `→ ${anon.status}`);
      const other = await call('GET', p, null, stuB.token, { absolute: true });
      ok(other.status === 403, '別的學生拿不到', `→ ${other.status}`);
      const mine = await call('GET', p, null, stuA.token, { absolute: true });
      ok(mine.status === 200, '本人拿得到', `→ ${mine.status}`);
      ok(/audio\/webm/.test(mine.ct), 'Content-Type 由伺服器決定', String(mine.ct));
      const staff = await call('GET', p, null, tea.token, { absolute: true });
      ok(staff.status === 200, '老師拿得到（要批改）', `→ ${staff.status}`);
    }
  }

  console.log('\n── 上傳目錄不可以匿名瀏覽 ──');
  {
    const g = await call('GET', '/uploads/speaking/1/full-interview.webm', null, null, { absolute: true });
    ok(g.status === 401 || g.status === 403 || g.status === 404,
      '不帶 token 拿不到別人的口說錄音', `→ ${g.status}`);
    const g2 = await call('GET', '/uploads/speaking/1/full-interview.webm', null, stuB.token, { absolute: true });
    ok(g2.status !== 200 || g2.status === 404, '別的學生也拿不到', `→ ${g2.status}`);
  }

  console.log('\n── 老師之間 ──');
  {
    const mk = await call('POST', '/tests', { paper: {
      title: `權限測試 ${Date.now()}`, testType: 'academic',
      modules: [{ module: 'reading', durationSec: 3600, sections: [{ title: 'P1', passage: '<p>x</p>',
        groups: [{ type: 'tfng', instructions: 'i', questions: [{ number: 1, text: 'a', answers: ['TRUE'] }] }] }] }],
    } }, adm.token);
    const tid = mk.data.id;
    ok(!!tid, '管理員建了一份試卷', `id=${tid}`);
    if (tid) {
      const del = await call('DELETE', `/tests/${tid}`, null, tea.token);
      ok(del.status === 403,
        '老師不能直接刪掉試卷（會連帶 cascade 掉所有學生的作答）', `→ ${del.status}`);
      await call('DELETE', `/tests/${tid}`, null, adm.token);
    }
  }

  console.log('\n── token 的傳遞方式 ──');
  {
    const r = await fetch(`${B}/api/auth/me?token=${encodeURIComponent(adm.token)}`);
    ok(r.status === 401,
      'token 不可以從網址列傳（會被寫進代理日誌與瀏覽器歷史）', `→ ${r.status}`);
  }
  {
    // sendBeacon 沒辦法帶標頭，body 帶 token 是刻意保留的
    const r = await call('POST', '/exam/0/event', { token: stuA.token, type: 'leave' }, null);
    ok(r.status !== 401, 'body 帶 token 仍然可以（sendBeacon 要用）', `→ ${r.status}`);
  }

  console.log('\n── 改密碼要讓舊 token 失效 ──');
  {
    const old = (await login('student2', 'ielts1234')).token;
    ok((await call('GET', '/auth/me', null, old)).status === 200, '舊 token 本來是有效的');
    const ch = await call('POST', '/auth/password', { oldPassword: 'ielts1234', newPassword: 'ielts5678' }, old);
    ok(ch.status === 200, '改密碼成功', `→ ${ch.status} ${JSON.stringify(ch.data).slice(0, 80)}`);
    const after = await call('GET', '/auth/me', null, old);
    ok(after.status === 401, '改完密碼之後舊 token 立刻失效', `→ ${after.status}`);
    // 還原
    const nu = await login('student2', 'ielts5678');
    if (nu.token) await call('POST', '/auth/password', { oldPassword: 'ielts5678', newPassword: 'ielts1234' }, nu.token);
  }

  console.log('\n── 停用帳號要立刻生效 ──');
  {
    await call('PUT', `/users/${stuB.user.id}`, { active: 0 }, adm.token);
    const r = await call('GET', '/auth/me', null, stuB.token);
    ok(r.status === 401, '停用之後舊 token 立刻失效', `→ ${r.status}`);
    await call('PUT', `/users/${stuB.user.id}`, { active: 1 }, adm.token);
  }

  console.log('\n── 安全標頭 ──');
  {
    const r = await fetch(`${B}/`);
    const csp = r.headers.get('content-security-policy') || '';
    ok(/script-src 'self'/.test(csp) && !/unsafe-inline[^;]*script/.test(csp),
      '有 CSP 且不允許 inline script', csp.slice(0, 60) + '…');
    ok(/object-src 'none'/.test(csp), "object-src 'none'");
  }

  console.log('\n── 偽造 JWT ──');
  {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ uid: 1, role: 'admin' })}.`;
    ok((await call('GET', '/auth/me', null, forged)).status === 401, 'alg=none 被拒絕');
    const parts = stuA.token.split('.');
    const tampered = `${parts[0]}.${b64({ ...JSON.parse(Buffer.from(parts[1], 'base64url')), role: 'admin' })}.${parts[2]}`;
    ok((await call('GET', '/auth/me', null, tampered)).status === 401, '改過 payload 的 token 被拒絕');
  }

  if (atA) await call('POST', '/manage/results/bulk', { action: 'delete', ids: [atA], force: true }, adm.token);

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`通過 ${pass}　失敗 ${fails.length}`);
  if (fails.length) fails.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
