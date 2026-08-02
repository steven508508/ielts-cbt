/* 口說考試頁：每一顆按鈕到底按不按得動。
 *
 * 學生回報「口說考試時頁面中的所有按鈕點下去都沒有反應」。
 * 按鈕沒反應有好幾種完全不同的成因，光看畫面分不出來：
 *   ① 上面蓋了一層看不見的東西，點擊根本沒到按鈕
 *   ② disabled，但外觀看起來還是可以按
 *   ③ 按下去到放開之間畫面重畫了，瀏覽器根本不會發出 click
 *   ④ click 有發出去，但 handler 卡在一個永遠不 resolve 的 await
 *
 * ⚠ 這一支一定要用 Playwright 的真實滑鼠（page.mouse / locator.click），
 *   不能用 el.click()。el.click() 是合成事件，直接跳過 mousedown/mouseup，
 *   ③ 那一類問題會完全測不到 —— 我第一版就是這樣把 bug 測成綠的。
 *
 *   node test/browser/speakingButtons.mjs
 */
import { useFakeAi, restoreAi, newExam, openSpeaking, sleep, say } from './speakingSim.mjs';

const line = (t) => console.log('   ' + t);
let bad = 0;

/* 進到頁面之前先埋兩個探針：
   · 數 replaceChildren 被叫了幾次（畫面重畫的頻率）
   · 記錄所有真的送到 document 的 click / mousedown / mouseup */
const PROBE = () => {
  window.__rerenders = [];
  const orig = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...a) {
    window.__rerenders.push({ t: performance.now(), el: this.id || this.className || this.tagName });
    return orig.apply(this, a);
  };
  window.__events = [];
  for (const type of ['mousedown', 'mouseup', 'click']) {
    document.addEventListener(type, (e) => {
      window.__events.push({ type, target: (e.target.textContent || '').trim().slice(0, 14) });
    }, true);
  }
};

const visibleButtons = (pg) => pg.evaluate(() => [...document.querySelectorAll('button')]
  .filter((b) => b.offsetWidth > 0 && b.offsetHeight > 0)
  .map((b) => ({ 文字: (b.textContent || '').trim(), disabled: b.disabled })));

/** 用真實滑鼠去按，回報整個過程 */
async function realClick(pg, text) {
  await pg.evaluate(() => { window.__events = []; });
  const before = await pg.evaluate(() => ({
    html: document.body.innerHTML.length,
    dim: !!document.querySelector('.cbt-dim'),
    rr: window.__rerenders.length,
  }));
  const loc = pg.locator('button', { hasText: text }).first();
  let err = null;
  try { await loc.click({ timeout: 4000 }); } catch (e) { err = String(e.message).split('\n')[0].slice(0, 90); }
  await sleep(900);
  const ev = await pg.evaluate(() => window.__events.map((e) => e.type));
  const after = await pg.evaluate(() => ({
    html: document.body.innerHTML.length,
    dim: !!document.querySelector('.cbt-dim'),
    rr: window.__rerenders.length,
  }));
  const gotClick = ev.includes('click');
  if (err) {
    const why = await pg.evaluate((t) => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === t);
      if (!b) return { 找不到按鈕: true };
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        位置: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        中心點上面是: top ? `${top.tagName.toLowerCase()}.${(top.className || '').toString().split(' ').filter(Boolean).join('.')}` : '(視窗外)',
        有遮罩: !!document.querySelector('.cbt-dim'),
        disabled: b.disabled,
        動畫中: b.getAnimations ? b.getAnimations({ subtree: true }).map((a) => a.animationName || a.id).join(',') : '?',
      };
    }, text);
    line(`     ↳ ${JSON.stringify(why, null, 0)}`);
  }
  const changed = before.html !== after.html || before.dim !== after.dim;
  const okNow = !err && gotClick && changed;
  if (!okNow) bad++;
  line(`${text.padEnd(14)} ${okNow ? '✓' : '✗'}  事件=[${ev.join(',') || '無'}]`
    + `  畫面${changed ? '有變' : '沒變'}`
    + `  重畫${after.rr - before.rr}次`
    + (before.dim ? '  ⚠按之前就已經有遮罩開著' : '')
    + (err ? `  點不到：${err}` : ''));
  // 有對話框就收掉，免得擋住下一顆。可能疊了好幾層，收到乾淨為止。
  for (let i = 0; i < 5; i++) {
    const n = await pg.evaluate(() => {
      const dims = document.querySelectorAll('.cbt-dim');
      if (!dims.length) return 0;
      // 收最上面那一個（後面的蓋在前面上面）
      const b = [...dims[dims.length - 1].querySelectorAll('.cbt-btn')][0];
      if (b) b.click();
      return dims.length;
    });
    if (!n) break;
    await sleep(450);
  }
  await sleep(300);
  return okNow;
}

async function rerenderRate(pg, ms = 4000) {
  await pg.evaluate(() => { window.__rerenders = []; });
  await sleep(ms);
  const list = await pg.evaluate(() => window.__rerenders);
  return { n: list.length, per秒: (list.length / (ms / 1000)).toFixed(1), who: [...new Set(list.map((r) => r.el))].slice(0, 4) };
}

await useFakeAi();

// ══ 情境 A：即時對話模式 ══════════════════════════════════
console.log('━━━ A 即時對話模式 ━━━');
{
  const ex = await newExam('student1');
  const { br, pg, errors } = await openSpeaking(ex, { init: PROBE });
  await sleep(2000);
  const rr = await rerenderRate(pg);
  line(`閒置 4 秒內畫面重畫 ${rr.n} 次（${rr.per秒}/秒）${rr.who.length ? ' ← ' + rr.who.join(', ') : ''}`);
  if (rr.n > 4) { bad++; line('  ✗ 重畫太頻繁：按下去到放開之間畫面被換掉，瀏覽器就不會發出 click'); }

  for (const b of await visibleButtons(pg)) {
    if (b.disabled) { line(`${b.文字.padEnd(14)} · disabled`); continue; }
    await realClick(pg, b.文字);
  }

  /* 按鈕會不會自己跑掉。
     逐字稿多一行、即時分數出現、計時器顯示，如果按鈕跟著往下移，
     學生按下去的那一瞬間按鈕就不在原位 —— mousedown 跟 mouseup 落在
     不同元素上，瀏覽器不會發出 click，畫面上什麼都不會發生。
     這是「所有按鈕都沒反應」最難查的一種成因，因為事後去看一切正常。 */
  console.log('\n   ── 對話進行中，按鈕位置會不會跑掉 ──');
  const posOf = () => pg.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('button')].filter((b) => b.offsetWidth)
      .map((b) => [(b.textContent || '').trim(), Math.round(b.getBoundingClientRect().top)])));
  const p0 = await posOf();
  await say('My name is Wang Xiaoming and I am from Taipei.');
  await sleep(2500);
  const p1 = await posOf();
  let worst = 0, worstName = '';
  for (const [k, v] of Object.entries(p0)) {
    if (p1[k] == null) continue;
    const d = Math.abs(p1[k] - v);
    if (d > worst) { worst = d; worstName = k; }
  }
  line(`對話多兩則之後，位移最大的是「${worstName}」${worst}px`);
  if (worst > 4) { bad++; line('  ✗ 按鈕會跟著內容跑 —— 學生按到一半按鈕就不在原位了'); }
  else line('  ✓ 按鈕釘住沒動');

  console.log('\n   ── 學生講過話、考官回過話之後再按一次 ──');
  await sleep(300);
  for (const b of await visibleButtons(pg)) {
    if (b.disabled) { line(`${b.文字.padEnd(14)} · disabled`); continue; }
    await realClick(pg, b.文字);
  }
  if (errors.length) { console.log('\n   ── 主控台錯誤 ──'); errors.slice(0, 5).forEach((e) => line(String(e).slice(0, 180))); }
  await pg.screenshot({ path: '/tmp/spk-btn-live.png' });
  await br.close(); await ex.cleanup();
}

// ══ 情境 B：全螢幕底下（正式考試就是這樣）══════════════════
console.log('\n━━━ B 全螢幕底下 ━━━');
{
  const ex = await newExam('student1');
  const { br, pg } = await openSpeaking(ex, { init: PROBE });
  await sleep(1800);
  const fs = await pg.evaluate(async () => {
    try { await document.documentElement.requestFullscreen(); } catch { /* 無妨 */ }
    return !!document.fullscreenElement;
  });
  line(`進入全螢幕 = ${fs}`);
  await sleep(600);
  const seen = await pg.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Help/.test(x.textContent));
    if (b) b.click();
    return null;
  });
  await sleep(900);
  const vis = await pg.evaluate(() => {
    const d = document.querySelector('.cbt-dialog');
    if (!d) return { 有對話框: false };
    const r = d.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
    return {
      有對話框: true,
      看得到: r.width > 100 && r.height > 100,
      中心點上面是: top ? `${top.tagName.toLowerCase()}.${(top.className || '').toString().split(' ').join('.')}` : '(無)',
      在全螢幕元素裡: document.fullscreenElement ? document.fullscreenElement.contains(d) : null,
    };
  });
  Object.entries(vis).forEach(([k, v]) => line(`${k}：${v}`));
  if (vis.有對話框 && vis.在全螢幕元素裡 === false) {
    bad++; line('  ✗ 對話框不在全螢幕元素裡 → 全螢幕考試時整個看不到');
  }
  await pg.screenshot({ path: '/tmp/spk-btn-fs.png' });
  await br.close(); await ex.cleanup();
}

await restoreAi();
console.log(bad ? `\n✗ ${bad} 項有問題\n` : '\n✓ 按鈕全部有反應\n');
process.exit(bad ? 1 : 0);
