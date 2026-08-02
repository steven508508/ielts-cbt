/* 聽力（以及其他科）會不會「吞題目」。
 *
 * 學生回報：題庫裡明明有、底部的題號列也有、可是該有題目的地方就是沒有。
 *
 * 成因：學生端是 `if (g.bodyHtml)` 一律把 bodyHtml 當成題目的版面，
 * 而驗證那邊的空格檢查只對 gap_fill / gap_fill_bank 做。於是一個
 * short_answer 或 mcq_single 題組只要身上帶著一段殘留的 bodyHtml
 * （換題型、匯入、AI 出題、題庫沿用、備份還原都會發生），整組題目
 * 就完全不會畫出來 —— 而 flat() 照樣算進底部題號列。
 * 實測一份 7 題的聽力卷被吞掉 5 題，畫面上沒有任何錯誤。
 *
 * 這一支**直接把壞掉的試卷寫進資料庫**，繞過驗證 —— 因為驗證現在會擋，
 * 但升級之前就已經存進去的那些試卷還是會被學生遇到，那才是真正要救的。
 *
 *   node test/browser/swallowed.mjs
 */
import { chromium } from './_pw.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../../server/db.js');

const B = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(m, p, b, t) {
  const h = {}; if (t) h.authorization = `Bearer ${t}`; if (b) h['content-type'] = 'application/json';
  const r = await fetch(B + '/api' + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
let bad = 0;
const ok = (c, label, extra = '') => { console.log(`  ${c ? '✓' : '✗'} ${label}${extra ? `　${extra}` : ''}`); if (!c) bad += 1; };

const adm = (await call('POST', '/auth/login', { username: 'admin', password: 'admin1234' })).data.token;
const tea = (await call('POST', '/auth/login', { username: 'teacher1', password: 'teach1234' })).data;
const stu = (await call('POST', '/auth/login', { username: 'student1', password: 'ielts1234' })).data;

/* 三種真的會發生的壞形狀，全部塞在同一份聽力卷裡 */
const paper = {
  title: `吞題 ${Date.now()}`, testType: 'academic',
  modules: [{ module: 'listening', durationSec: 1800, sections: [{
    title: 'Section 1', audio: '/uploads/audio/testtone.mp3',
    groups: [
      // ① 正常的填空題（空格對得上）
      { type: 'gap_fill', instructions: 'Complete the form.',
        bodyHtml: '<p>Name: [[1]]<br>Age: [[2]]</p>',
        questions: [{ number: 1, text: '', answers: ['Smith'] }, { number: 2, text: '', answers: ['30'] }] },
      // ② 填空題，但版面只有一半的空格（重新編號、插題之後最常見）
      { type: 'gap_fill', instructions: 'Complete the notes.',
        bodyHtml: '<p>Street: [[3]]</p>',
        questions: [{ number: 3, text: '', answers: ['Oak'] },
          { number: 4, text: 'What time does it open?', answers: ['9am'] }] },
      // ③ 不吃 bodyHtml 的題型帶著殘留的版面
      { type: 'short_answer', instructions: 'Answer the questions.', bodyHtml: '<p>Questions 5-6</p>',
        questions: [{ number: 5, text: 'How much is the fee?', answers: ['20'] },
          { number: 6, text: 'Who should you call?', answers: ['Ann'] }] },
      { type: 'mcq_single', instructions: 'Choose the correct letter.', bodyHtml: '<p>Question 7</p>',
        options: [{ key: 'A', text: 'Monday' }, { key: 'B', text: 'Tuesday' }],
        questions: [{ number: 7, text: 'Which day is the class?', answers: ['A'] }] },
    ],
  }] }],
};

const OPT = [{ key: 'A', text: 'Alpha' }, { key: 'B', text: 'Beta' }, { key: 'C', text: 'Gamma' }];
const L = (g) => ({ title: `驗證 ${Date.now()}`, testType: 'academic',
  modules: [{ module: 'listening', durationSec: 1800,
    sections: [{ title: 'S2', audio: '/uploads/audio/testtone.mp3', groups: [g] }] }] });

console.log('\n【驗證：合法的版面不可以被誤擋】');
for (const [name, g] of Object.entries({
  '配對題用 bodyHtml 排流程圖（每格一個下拉）': { type: 'matching', instructions: 'Match.', options: OPT,
    bodyHtml: '<table><tr><td>Stage 1</td><td>[[1]]</td></tr><tr><td>Stage 2</td><td>[[2]]</td></tr></table>',
    questions: [{ number: 1, text: '', answers: ['A'] }, { number: 2, text: '', answers: ['B'] }] },
  '配對題不用 bodyHtml（傳統列表）': { type: 'matching', instructions: 'Match.', options: OPT,
    questions: [{ number: 1, text: 'Speaker 1', answers: ['A'] }] },
  '選擇題用 bodyHtml 當情境資料（時刻表＋選擇題）': { type: 'mcq_single', instructions: 'Choose.', options: OPT,
    bodyHtml: '<table><tr><td>09:00 Train</td></tr></table>',
    questions: [{ number: 1, text: 'Which train?', answers: ['A'] }] },
  '簡答題用筆記版面': { type: 'short_answer', instructions: 'Complete.', bodyHtml: '<p>Name: [[1]]</p>',
    questions: [{ number: 1, text: '', answers: ['Smith'] }] },
})) {
  const r = await call('POST', '/tests', { paper: L(g) }, tea.token);
  ok(r.status === 200, name, r.status === 200 ? '' : (r.data.errors || [])[0]);
  if (r.data.id) await call('DELETE', `/tests/${r.data.id}`, { force: true }, adm);
}

console.log('\n【驗證：真的會讓學生看不到題目的才擋】');
for (const [name, g, want] of [
  ['填空題沒有題幹、版面也沒有空格', { type: 'gap_fill', instructions: 'i', bodyHtml: '<p>沒有空格</p>',
    questions: [{ number: 1, text: '', answers: ['x'] }] }, /看不到題目/],
  ['空格指向不存在的題目（重新編號沒改版面）', { type: 'matching', instructions: 'i', options: OPT,
    bodyHtml: '<p>[[8]] [[9]]</p>',
    questions: [{ number: 1, text: 'Speaker 1', answers: ['A'] }] }, /沒有對應的題目/],
]) {
  const r = await call('POST', '/tests', { paper: L(g) }, tea.token);
  const errs = (r.data.errors || []).join(' ');
  ok(r.status === 400 && want.test(errs), name, errs.slice(0, 70) || `→ ${r.status}`);
}

/* 前面那些「合法」的判斷，前提是學生端真的畫得出來。
   配對題的空格必須是**下拉選單**（從選項清單挑），不是文字框 ——
   這一段就是在驗那個前提，不是憑印象說它支援。 */
console.log('\n【配對題用 bodyHtml 排版面：學生端真的畫成下拉嗎】');
{
  const mp = L({ type: 'matching', instructions: 'Match each stage to a person.', options: OPT,
    bodyHtml: '<table><tr><td>Stage 1</td><td>[[1]]</td></tr><tr><td>Stage 2</td><td>[[2]]</td></tr></table>',
    questions: [{ number: 1, text: '', answers: ['A'] }, { number: 2, text: '', answers: ['B'] }] });
  const t2 = await call('POST', '/tests', { paper: mp }, tea.token);
  const a2 = await call('POST', '/tests/assignments',
    { testId: t2.data.id, userIds: [stu.user.id], modules: 'listening', maxAttempts: 9 }, tea.token);
  const s2 = await call('POST', '/exam/start', { assignmentId: a2.data.ids[0], testId: t2.data.id }, stu.token);
  const at2 = s2.data.attemptId;

  const br2 = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const p2 = await br2.newPage();
  await p2.setViewportSize({ width: 1280, height: 900 });
  await p2.goto(B);
  await p2.evaluate(async () => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'student1', password: 'ielts1234' }) });
    const j = await r.json();
    localStorage.setItem('ielts_token', j.token); localStorage.setItem('ielts_user', JSON.stringify(j.user));
  });
  await p2.goto(`${B}/#/exam/${at2}`); await p2.reload(); await sleep(2600);
  for (let i = 0; i < 10; i++) {
    if (await p2.$('.cbt-group')) break;
    await p2.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => /^(資料正確|繼續|開始|我聽得很清楚)/.test(x.textContent.trim()) && !x.disabled && x.offsetWidth);
      if (b) b.click();
    });
    await sleep(1500);
  }
  await sleep(900);
  const m = await p2.evaluate(() => ({
    下拉數: document.querySelectorAll('.cbt-sel').length,
    下拉選項: [...(document.querySelector('.cbt-sel')?.options || [])].map((o) => o.value),
    有選項清單: !!document.querySelector('.cbt-bank'),
    表格還在: !!document.querySelector('.cbt-body table'),
    題號: [...document.querySelectorAll('[id^="q-"]')].map((n) => n.id.replace('q-', '')),
    警示: !!document.querySelector('#q-audit'),
  }));
  ok(m.下拉數 === 2, '兩個空格都畫成下拉選單', `${m.下拉數} 個`);
  ok(m.下拉選項.join(',') === ',A,B,C', '下拉裡是選項清單的字母', m.下拉選項.join(','));
  ok(m.有選項清單, '上方有 List of options');
  ok(m.表格還在, '流程圖／表格的版面有保留');
  ok(m.題號.join(',') === '1,2', '題號對得上', m.題號.join(','));
  ok(!m.警示, '沒有觸發吞題警示');

  await p2.selectOption('.cbt-sel', 'C');
  await sleep(2200);
  const saved2 = await call('GET', `/exam/${at2}`, null, stu.token);
  const got = (saved2.data?.saved?.answers || []).find((x) => Number(x.q_number) === 1);
  ok(got?.response === 'C', '選了之後存得起來（存的是字母）', String(got?.response));
  await p2.screenshot({ path: '/tmp/matching-body.png' });
  await br2.close();
  await call('DELETE', `/tests/assignments/${a2.data.ids[0]}`, null, tea.token);
  await call('POST', '/manage/results/bulk', { action: 'delete', ids: [at2], force: true }, adm);
  await call('DELETE', `/tests/${t2.data.id}`, { force: true }, adm);
}

console.log('\n【已經存進去的壞試卷，學生端要救得回來】');
// 繞過驗證直接寫進資料庫 —— 這就是升級之前存下來的那些試卷
const testId = await db.insert(
  'INSERT INTO tests (title, test_type, description, content, published, created_by) VALUES (?,?,?,?,?,?)',
  [paper.title, 'academic', null, JSON.stringify(paper), 1, null]);
const asg = await call('POST', '/tests/assignments',
  { testId, userIds: [stu.user.id], modules: 'listening', maxAttempts: 9 }, tea.token);
const st = await call('POST', '/exam/start', { assignmentId: asg.data.ids[0], testId }, stu.token);
const at = st.data.attemptId;

const br = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const pg = await br.newPage();
await pg.setViewportSize({ width: 1280, height: 900 });
await pg.goto(B);
await pg.evaluate(async () => {
  const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'student1', password: 'ielts1234' }) });
  const j = await r.json();
  localStorage.setItem('ielts_token', j.token); localStorage.setItem('ielts_user', JSON.stringify(j.user));
});
await pg.goto(`${B}/#/exam/${at}`); await pg.reload(); await sleep(2600);
for (let i = 0; i < 10; i++) {
  if (await pg.$('.cbt-group')) break;
  await pg.evaluate(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /^(資料正確|繼續|開始|我聽得很清楚)/.test(x.textContent.trim()) && !x.disabled && x.offsetWidth);
    if (b) b.click();
  });
  await sleep(1500);
}
await sleep(1000);

const r = await pg.evaluate(() => ({
  底部: [...document.querySelectorAll('.cbt-num')].map((b) => b.textContent.trim()),
  作答區: [...document.querySelectorAll('[id^="q-"]')].map((n) => n.id.replace('q-', '')),
  題幹: [...document.querySelectorAll('.cbt-stem')].map((n) => n.textContent.trim()),
  可作答: [...document.querySelectorAll('.cbt-gap, .cbt-opt input, .cbt-sel, .cbt-q input[type=text]')].length,
  警示: document.querySelector('#q-audit')?.textContent || null,
}));
const missing = r.底部.filter((n) => !r.作答區.includes(n));
console.log(`   底部題號列 = ${r.底部.join(',')}`);
console.log(`   作答區畫出 = ${r.作答區.join(',')}`);
ok(r.底部.length === 7, '底部題號列有 7 題', String(r.底部.length));
ok(missing.length === 0, '每一題都畫出來了，一題都沒有被吞掉',
  missing.length ? `少了 ${missing.join('、')}` : '');
ok(r.題幹.includes('How much is the fee?'), '殘留 bodyHtml 的那組題幹看得到');
ok(r.題幹.includes('Which day is the class?'), '選擇題的題幹也看得到');
ok(r.題幹.includes('What time does it open?'), '空格沒涵蓋到的那一題也補畫出來了');
ok(r.可作答 >= 7, '每一題都有可以作答的欄位', `${r.可作答} 個`);
ok(!r.警示, '沒有觸發「有題目沒畫出來」的警示');

// 真的能答、能存
await pg.evaluate(() => {
  const inputs = [...document.querySelectorAll('.cbt-q input[type=text], .cbt-gap')];
  inputs.forEach((i, k) => { i.value = `ZQX${k}`; i.dispatchEvent(new Event('input', { bubbles: true })); });
});
await sleep(2500);
const saved = await call('GET', `/exam/${at}`, null, stu.token);
const rows = (saved.data?.saved?.answers || []).filter((x) => x.module === 'listening' && String(x.response || '').startsWith('ZQX'));
ok(rows.length >= 5, '這些題目答得下去、也存得起來', `伺服器收到 ${rows.length} 題`);
const nums = rows.map((x) => Number(x.q_number)).sort((a, b) => a - b);
ok(nums.every((n) => n >= 1 && n <= 7), '存下來的題號都在範圍內', nums.join(','));

await pg.screenshot({ path: '/tmp/swallowed.png', fullPage: true });
await br.close();
await call('DELETE', `/tests/assignments/${asg.data.ids[0]}`, null, tea.token);
await call('POST', '/manage/results/bulk', { action: 'delete', ids: [at], force: true }, adm);
await db.exec('DELETE FROM tests WHERE id = ?', [testId]);

console.log(bad ? `\n✗ ${bad} 項不合格\n` : '\n✓ 一題都沒有被吞掉\n');
process.exit(bad ? 1 : 0);
