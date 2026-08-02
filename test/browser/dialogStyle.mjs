/* 對話框到底長什麼樣子。
 *
 * 這一支是為了 v2.21.0 的回歸寫的。上一版為了修「按鈕完全沒反應」，
 * 把 .cbt-dim 從 .cbt 裡搬到 document.body —— 按鈕是好了，但所有配色
 * 變數（--c-bg / --c-line / --c-accent / --cbt-font）都定義在 .cbt 上，
 * 搬出去之後全部變成未定義：對話框沒有底色、沒有外框、沒有陰影，
 * OK 也不像按鈕。API 測試全綠，單元測試也全綠，只有真的開瀏覽器
 * 去量 computed style 才看得出來。
 *
 * Playwright 不是這個專案的相依套件，要跑的話先裝：
 *   npm i -D playwright && npx playwright install chromium
 *   node test/browser/dialogStyle.mjs
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
const ok = (cond, label, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? `　${extra}` : ''}`);
  if (!cond) bad++;
};
/** rgba(r,g,b,a) → a。沒有 alpha 的 rgb() 當作 1；transparent 是 0 */
const alphaOf = (c) => {
  const m = /rgba?\(([^)]+)\)/.exec(c || '');
  if (!m) return 0;
  const parts = m[1].split(',').map((s) => parseFloat(s));
  return parts.length > 3 ? parts[3] : 1;
};

const adm = (await call('POST', '/auth/login', { username: 'admin', password: 'admin1234' })).data.token;
const tea = (await call('POST', '/auth/login', { username: 'teacher1', password: 'teach1234' })).data;
const stu = (await call('POST', '/auth/login', { username: 'student1', password: 'ielts1234' })).data;

const paper = {
  title: `對話框樣式 ${Date.now()}`, testType: 'academic',
  modules: [{ module: 'reading', durationSec: 3600, sections: [{ title: 'Passage 1',
    passage: '<p>Cities plant trees to cool their streets.</p>',
    groups: [{ type: 'tfng', instructions: 'TRUE / FALSE / NOT GIVEN',
      questions: [{ number: 1, text: 'Cities plant trees.', answers: ['TRUE'] }] }] }] }],
};
const t = await call('POST', '/tests', { paper }, tea.token);
const asg = await call('POST', '/tests/assignments',
  { testId: t.data.id, userIds: [stu.user.id], modules: 'reading', maxAttempts: 9 }, tea.token);
const st = await call('POST', '/exam/start', { assignmentId: asg.data.ids[0], testId: t.data.id }, stu.token);
const at = st.data.attemptId;

const br = await chromium.launch({ args: ['--no-sandbox'] });

/** 開一個帶著（或不帶）偏好設定的考試頁，停在模組清單那一頁 */
async function openExam(prefs) {
  const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(([tk, u, pf]) => {
    localStorage.setItem('ielts_token', tk);
    localStorage.setItem('ielts_user', JSON.stringify(u));
    if (pf) localStorage.setItem('ielts_cbt_prefs', JSON.stringify(pf));
  }, [stu.token, stu.user, prefs]);
  const pg = await ctx.newPage();
  await pg.goto(`${B}/#/exam/${at}`); await sleep(900); await pg.reload(); await sleep(2400);
  await clickByText(pg, /^(資料正確|繼續)/);
  await sleep(1600);
  return { ctx, pg };
}
async function clickByText(pg, re) {
  for (const b of await pg.$$('button')) {
    const tx = ((await b.textContent()) || '').trim();
    if (re.test(tx) && await b.isVisible() && await b.isEnabled()) {
      await b.click().catch(() => {}); return true;
    }
  }
  return false;
}
const measure = (pg) => pg.evaluate(() => {
  const dim = document.querySelector('.cbt-dim');
  const dlg = document.querySelector('.cbt-dialog');
  if (!dim || !dlg) return null;
  const cd = getComputedStyle(dim), cg = getComputedStyle(dlg);
  const btn = [...dlg.querySelectorAll('.cbt-btn')].pop();
  const r = dlg.getBoundingClientRect();
  return {
    帶cbt: dim.classList.contains('cbt'),
    在body底下: dim.parentElement === document.body,
    遮罩: cd.backgroundColor,
    底色: cg.backgroundColor,
    文字: cg.color,
    外框色: cg.borderTopColor,
    外框寬: cg.borderTopWidth,
    陰影: cg.boxShadow,
    字級: cg.fontSize,
    寬: Math.round(r.width), 高: Math.round(r.height),
    中心x: Math.round(r.left + r.width / 2),
    OK底: btn ? getComputedStyle(btn).backgroundColor : null,
    OK字: btn ? getComputedStyle(btn).color : null,
  };
});

// ── 1. 預設配色：該有的樣式一個都不能少 ────────────────────
console.log('\n【1】預設配色下開 Help');
{
  const { ctx, pg } = await openExam(null);
  await clickByText(pg, /Help/); await sleep(800);
  const m = await measure(pg);
  if (!m) { ok(false, '對話框有出現'); }
  else {
    ok(m.帶cbt, '遮罩帶著 cbt（配色變數才吃得到）');
    ok(m.在body底下, '掛在 body，不會被重畫拔掉');
    ok(alphaOf(m.遮罩) > 0.2 && alphaOf(m.遮罩) < 1, '遮罩是半透明深色', m.遮罩);
    ok(alphaOf(m.底色) === 1, '對話框底色不透明', m.底色);
    ok(m.底色 === 'rgb(255, 255, 255)', '底色 = --c-bg', m.底色);
    ok(m.文字 === 'rgb(28, 28, 28)', '文字 = --c-fg', m.文字);
    ok(parseFloat(m.外框寬) >= 1 && alphaOf(m.外框色) === 1, '有實心外框', `${m.外框寬} ${m.外框色}`);
    ok(m.陰影 !== 'none', '有陰影');
    ok(m.字級 === '15px', '字級 = --cbt-font 標準', m.字級);
    ok(m.OK底 === 'rgb(0, 92, 138)', 'OK 是實心主色按鈕，不是一行純文字', m.OK底);
    ok(m.OK字 === 'rgb(255, 255, 255)', 'OK 字是反白', m.OK字);
    ok(Math.abs(m.中心x - 640) < 20, '水平置中', `x=${m.中心x}`);
  }
  await pg.screenshot({ path: '/tmp/dlgtest-default.png' });
  await ctx.close();
}

// ── 2. 學生先前選了高對比：對話框要跟著變 ──────────────────
console.log('\n【2】黑底黃字 + 大字（沿用上次設定）');
{
  const { ctx, pg } = await openExam({ scheme: 'yellow-black', size: 'large' });
  await clickByText(pg, /Help/); await sleep(800);
  const m = await measure(pg);
  if (!m) { ok(false, '對話框有出現'); }
  else {
    ok(m.底色 === 'rgb(26, 26, 26)', '底色跟著變黑', m.底色);
    ok(m.文字 === 'rgb(255, 233, 92)', '文字跟著變黃', m.文字);
    ok(m.字級 === '18px', '字級跟著放大到 large', m.字級);
    ok(m.OK底 === 'rgb(255, 233, 92)', 'OK 按鈕也換成高對比配色', m.OK底);
  }
  await pg.screenshot({ path: '/tmp/dlgtest-contrast.png' });
  await ctx.close();
}

// ── 3. 在「顯示設定」裡當場換配色，手上這個框要立刻跟著變 ──
console.log('\n【3】在設定對話框裡當場換配色');
{
  const { ctx, pg } = await openExam(null);
  await clickByText(pg, /Settings|顯示設定/); await sleep(800);
  const before = await measure(pg);
  const hit = await pg.evaluate(() => {
    const l = [...document.querySelectorAll('.cbt-radioline label')]
      .find((x) => /黑底黃字/.test(x.textContent));
    if (!l) return false; l.click(); return true;
  });
  await sleep(500);
  const after = await measure(pg);
  ok(hit, '找得到「黑底黃字」這個選項');
  ok(before && before.底色 === 'rgb(255, 255, 255)', '換之前是白底', before?.底色);
  ok(after && after.底色 === 'rgb(26, 26, 26)',
    '按下去之後，正開著的這個設定框自己也變黑了（不然學生會以為沒生效）', after?.底色);
  ok(after && after.文字 === 'rgb(255, 233, 92)', '文字同時變黃', after?.文字);
  await pg.screenshot({ path: '/tmp/dlgtest-live.png' });
  await ctx.close();
}

// ── 4. 原本那個 bug 不能回來：按了要真的關掉，重畫也不能弄死它 ──
console.log('\n【4】按鈕還是要有反應（守住 v2.21.0 修的東西）');
{
  const { ctx, pg } = await openExam(null);
  await clickByText(pg, /Help/); await sleep(700);
  ok(await pg.evaluate(() => !!document.querySelector('.cbt-dim')), '對話框開著');
  // 對話框開著的時候硬塞一次重畫：以前這一下就會把 Promise 弄死
  await pg.evaluate(() => {
    const root = document.querySelector('.cbt')?.parentElement;
    if (root) root.replaceChildren(...root.childNodes);
  });
  await sleep(400);
  ok(await pg.evaluate(() => !!document.querySelector('.cbt-dim')), '重畫之後對話框還在');
  await clickByText(pg, /^OK$/); await sleep(600);
  ok(await pg.evaluate(() => !document.querySelector('.cbt-dim')), '按 OK 真的關得掉');
  await ctx.close();
}

// ── 5. 對話框開著的時候，底下的按鈕本來就點不動 ──────────────
// 這正是「頁面上所有按鈕都沒反應」的機制：遮罩 inset:0 z-index:1300，
// 開著就吃掉整頁的點擊。所以對話框只要有一次畫不出來，學生看到的就是
// 一個完全沒有反應、也沒有任何線索的畫面。
console.log('\n【5】對話框開著時，整頁的按鈕會被擋住（這是刻意的）');
{
  const { ctx, pg } = await openExam(null);
  await clickByText(pg, /Help/); await sleep(800);
  const blocked = await pg.evaluate(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /Settings|顯示設定/.test(x.textContent) && x.offsetWidth);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { 被擋: !!top && !b.contains(top) && top !== b, 擋住的是: top?.className || top?.tagName };
  });
  ok(blocked && blocked.被擋, '底下的按鈕確實被遮罩擋住', String(blocked?.擋住的是));

  // 點遮罩：不可關的對話框至少要抖一下，否則學生以為整頁壞了
  await pg.evaluate(() => {
    const d = document.querySelector('.cbt-dim');
    const r = d.getBoundingClientRect();
    d.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 8, clientY: r.top + 8 }));
  });
  await sleep(100);
  ok(await pg.evaluate(() => !!document.querySelector('.cbt-dialog.nudge')),
    '點遮罩會讓對話框抖一下（把注意力帶回來）');
  await ctx.close();
}

// ── 6. 樣式表整個沒載到，也不能把學生鎖死 ────────────────────
// 舊快取、CDN 拿到半條命的檔案、部署到一半 —— 都會走到這裡。
// 沒有這層保險的話，遮罩照樣蓋滿畫面吃掉所有點擊，但學生看不到任何東西。
console.log('\n【6】cbt.css 完全載不到時的保險');
{
  const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(([tk, u]) => {
    localStorage.setItem('ielts_token', tk);
    localStorage.setItem('ielts_user', JSON.stringify(u));
  }, [stu.token, stu.user]);
  await ctx.route('**/css/cbt.css*', (route) => route.abort());
  const pg = await ctx.newPage();
  await pg.goto(`${B}/#/exam/${at}`); await sleep(900); await pg.reload(); await sleep(2400);
  await clickByText(pg, /^(資料正確|繼續)/); await sleep(1600);
  await clickByText(pg, /Help/); await sleep(900);
  const m = await measure(pg);
  if (!m) { ok(false, '對話框有出現'); }
  else {
    ok(alphaOf(m.底色) === 1, '仍然有不透明底色（行內樣式接手）', m.底色);
    ok(m.寬 > 100 && m.高 > 60, '仍然有正常大小', `${m.寬}×${m.高}`);
    ok(alphaOf(m.OK底) === 1, 'OK 仍然是看得見的按鈕', m.OK底);
    const reach = await pg.evaluate(() => {
      const b = [...document.querySelectorAll('.cbt-dialog .cbt-btn')].pop();
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!top && (top === b || b.contains(top));
    });
    ok(reach, 'OK 按得到，學生不會被鎖在畫面裡');
  }
  await pg.screenshot({ path: '/tmp/dlgtest-nocss.png' });
  await ctx.close();
}

await br.close();
await call('DELETE', `/tests/assignments/${asg.data.ids[0]}`, null, tea.token);
await call('POST', '/manage/results/bulk', { action: 'delete', ids: [at], force: true }, adm);
await call('DELETE', `/tests/${t.data.id}`, null, adm);

console.log(bad ? `\n✗ ${bad} 項不合格\n` : '\n✓ 對話框樣式全部合格\n');
process.exit(bad ? 1 : 0);
