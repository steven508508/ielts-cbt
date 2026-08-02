/* 存檔失敗的時候，學生的作答會不會就這樣消失。
 *
 * 原本的行為：flush() 在送出**之前**就 pending.clear()，失敗之後沒有任何
 * 地方把它放回去、也沒有重試。一次 Wi-Fi 漫遊就吃掉那 900 毫秒內的所有
 * 題目，而畫面上只有一個 3 秒就消失的提示 —— 底部題號列的「已作答」深色
 * 標記是從記憶體算的，看起來一切正常。學生要等成績出來才知道整段是空的。
 * 寫作更糟：catch 是空的，連提示都沒有，結束畫面還直接寫「你的作文已儲存」。
 *
 * 這一支用 Playwright 的 route 攔截把儲存端點打掉，看作答還在不在。
 *
 *   node test/browser/saveLoss.mjs
 */
import { chromium } from './_pw.mjs';
const B = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(m, p, b, t) {
  const h = {}; if (t) h.authorization = `Bearer ${t}`; if (b) h['content-type'] = 'application/json';
  const r = await fetch(B + '/api' + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
let bad = 0;
const ok = (c, label, extra = '') => { console.log(`  ${c ? '✓' : '✗'} ${label}${extra ? `　${extra}` : ''}`); if (!c) bad++; };

const adm = (await call('POST', '/auth/login', { username: 'admin', password: 'admin1234' })).data.token;
const tea = (await call('POST', '/auth/login', { username: 'teacher1', password: 'teach1234' })).data;
const stu = (await call('POST', '/auth/login', { username: 'student1', password: 'ielts1234' })).data;

const paper = {
  title: `存檔 ${Date.now()}`, testType: 'academic',
  modules: [
    { module: 'reading', durationSec: 3600, sections: [{ title: 'Passage 1',
      passage: '<p>Cities plant trees to cool their streets.</p>',
      groups: [{ type: 'tfng', instructions: 'TRUE / FALSE / NOT GIVEN',
        questions: Array.from({ length: 4 }, (_, i) => ({ number: i + 1, text: `Statement ${i + 1}.`, answers: ['TRUE'] })) }] }] },
    { module: 'writing', durationSec: 3600, sections: [{ title: 'Task 1',
      groups: [{ type: 'writing_task', questions: [{ taskNo: 1, number: 1, minWords: 150, prompt: 'Describe the chart.' }] }] }] },
  ],
};
const t = await call('POST', '/tests', { paper }, tea.token);
if (t.status !== 200) { console.error('建卷失敗', JSON.stringify(t.data).slice(0, 300)); process.exit(2); }
const asg = await call('POST', '/tests/assignments',
  { testId: t.data.id, userIds: [stu.user.id], modules: 'reading,writing', maxAttempts: 9 }, tea.token);
const st = await call('POST', '/exam/start', { assignmentId: asg.data.ids[0], testId: t.data.id }, stu.token);
const at = st.data.attemptId;
const cleanup = async () => {
  await call('DELETE', `/tests/assignments/${asg.data.ids[0]}`, null, tea.token);
  await call('POST', '/manage/results/bulk', { action: 'delete', ids: [at], force: true }, adm);
  await call('DELETE', `/tests/${t.data.id}`, null, adm);
};

const br = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(([tk, u]) => {
  localStorage.setItem('ielts_token', tk); localStorage.setItem('ielts_user', JSON.stringify(u));
}, [stu.token, stu.user]);
const pg = await ctx.newPage();
await pg.goto(`${B}/#/exam/${at}`); await sleep(1000); await pg.reload(); await sleep(2400);
const FWD = /^(資料正確|繼續|開始|進入|下一步|我已閱讀|同意|我聽得很清楚)/;
for (let i = 0; i < 10; i++) {
  if (await pg.$('#q-1')) break;
  let c = false;
  for (const b of await pg.$$('button')) {
    const tx = ((await b.textContent()) || '').trim();
    if (FWD.test(tx) && !/離開|寫作|Writing/.test(tx) && await b.isVisible() && await b.isEnabled()) {
      await b.click().catch(() => {}); c = true; break;
    }
  }
  await sleep(1500); if (!c) break;
}

console.log('\n【1】斷網時作答，重新連上之後要自己補送出去');
{
  // 把儲存端點打掉
  let blocked = 0;
  await ctx.route('**/api/exam/*/answers', (route) => { blocked++; route.abort(); });
  await pg.click('#q-1 label.cbt-opt');
  await pg.click('#q-2 label.cbt-opt');
  await sleep(2200);
  ok(blocked > 0, '儲存請求確實被擋下來了', `擋掉 ${blocked} 次`);

  const state = await pg.evaluate(() => document.querySelector('#save-state')?.textContent || '(沒有這個欄位)');
  ok(/還沒存/.test(state), '閱讀的狀態列也看得到「還沒存出去」', `「${state}」`);
  const srv1 = await call('GET', `/exam/${at}`, null, stu.token);
  const saved1 = (srv1.data?.saved?.answers || []).filter((r) => r.module === 'reading').length;
  ok(saved1 === 0, '伺服器這時候確實還沒有這兩題', `伺服器有 ${saved1} 題`);

  // 網路回來
  await ctx.unroute('**/api/exam/*/answers');
  // 學生什麼都不做，只是等 —— 重試要自己發生
  await sleep(23000);
  const srv2 = await call('GET', `/exam/${at}`, null, stu.token);
  const saved2 = (srv2.data?.saved?.answers || []).filter((r) => r.module === 'reading').length;
  ok(saved2 >= 2, '網路回來之後系統自己把作答補送出去了（學生沒有再碰任何東西）',
    `伺服器現在有 ${saved2} 題`);

}

console.log('\n【2】寫作：存不出去的時候不能顯示「已自動儲存」');
{
  // 換到寫作
  await pg.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /結束這一科|結束閱讀/.test(x.textContent)); if (b) b.click(); });
  await sleep(900);
  await pg.evaluate(() => { const b = [...document.querySelectorAll('.cbt-dialog .cbt-btn')].pop(); if (b) b.click(); });
  await sleep(2000);
  for (let i = 0; i < 6; i++) {
    if (await pg.$('textarea')) break;
    await pg.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => /寫作|Writing|繼續|回到科目清單|開始/.test(x.textContent) && !x.disabled);
      if (b) b.click();
    });
    await sleep(1500);
  }
  const hasTa = await pg.$('textarea');
  ok(!!hasTa, '進得了寫作');
  if (hasTa) {
    let wblocked = 0;
    await ctx.route('**/api/exam/*/writing', (route) => { wblocked++; route.abort(); });
    await pg.fill('textarea', 'ZQXESSAY '.repeat(30));
    await sleep(2500);
    const state = await pg.evaluate(() => document.querySelector('#save-state')?.textContent || '(沒有這個欄位)');
    ok(wblocked > 0, '寫作儲存確實被擋下來了', `擋掉 ${wblocked} 次`);
    ok(/還沒存/.test(state), '狀態列說了實話，不是「已自動儲存」', `「${state}」`);

    await ctx.unroute('**/api/exam/*/writing');
    await sleep(23000);
    const srv = await call('GET', `/exam/${at}`, null, stu.token);
    const essay = (srv.data?.saved?.writing || []).map((w) => w.essay || '').join('');
    ok(String(essay).includes('ZQXESSAY'), '網路回來之後作文自己補送出去了', `長度 ${String(essay).length}`);
    const state2 = await pg.evaluate(() => document.querySelector('#save-state')?.textContent || '');
    ok(/已自動儲存/.test(state2), '存出去之後狀態列恢復正常', `「${state2}」`);
  }
}

await pg.screenshot({ path: '/tmp/saveloss.png' });
await br.close();
await cleanup();
console.log(bad ? `\n✗ ${bad} 項不合格\n` : '\n✓ 存檔不會靜靜掉答案\n');
process.exit(bad ? 1 : 0);
