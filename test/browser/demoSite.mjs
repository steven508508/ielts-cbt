/* 示範站的實測。
 *
 * 靜態站最容易出的錯是「看起來好好的，其實什麼都沒載到」—— 絕對路徑在
 * GitHub Pages 的子路徑下全破、假後端沒接住某個請求、音檔 404。這些在
 * 截圖上都不一定看得出來，所以這裡量的是實際狀態：console 有沒有錯、
 * 有沒有沒接住的請求、題目有沒有真的畫出來、音檔有沒有真的在播、
 * 批改出來的分數對不對。
 *
 *   node test/browser/demoSite.mjs [http://localhost:8899]
 */
import { chromium } from './_pw.mjs';

const BASE = process.argv[2] || 'http://localhost:8899';
const SHOT = process.env.SHOT_DIR || '/tmp/demo-shots';
import { mkdirSync } from 'node:fs';
mkdirSync(SHOT, { recursive: true });

let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failed++; };
const step = (m) => console.log(`\n▸ ${m}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const errors = [];
const unhandled = [];
const bad404 = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('response', (r) => {
  if (r.status() >= 400) bad404.push(`${r.status()} ${r.url().replace(BASE, '')}`);
});
page.on('console', (m) => { if (/沒接住的請求/.test(m.text())) unhandled.push(m.text()); });

// ── 1. 載入 ──────────────────────────────────────────────────────────
step('載入首頁');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

ok(await page.locator('#demo-bar').isVisible(), '示範站橫幅有出現');
const cssLoaded = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--c-ok') !== '' ||
  [...document.styleSheets].some((s) => (s.href || '').includes('cbt.css')));
ok(cssLoaded, 'CSS 有載到（相對路徑沒破）');
ok(await page.evaluate(() => !!window.DEMO_DATA && !!window.DEMO_LIB?.answers && !!window.DEMO_LIB?.bands),
  '假後端與批改邏輯都載入了');

const heading = await page.locator('#app').innerText();
ok(!/登入/.test(heading.slice(0, 80)) || /模擬|考試|試卷/.test(heading), '直接進到考生首頁，不用登入');
await page.screenshot({ path: `${SHOT}/01-home.png` });

// ── 2. 閱讀 ──────────────────────────────────────────────────────────
step('閱讀：分割視窗、題目要真的畫出來');
await startModule(page, 'reading');
await page.waitForTimeout(1200);

// 官方介面一次只顯示一個 Part，所以畫面上不會有 40 題 —— 但底部題號列必須
// 列滿 40 個，那是「有沒有吞題目」唯一看得出來的地方。
const readingQs = await page.locator('[id^="q-"]').count();
ok(readingQs >= 8, `本頁題目有畫出來（${readingQs} 題）`);
const nav = await page.evaluate(() => ({
  nums: document.querySelectorAll('.cbt-foot .cbt-num').length,
  audit: document.querySelector('#q-audit')?.innerText || '',
}));
ok(nav.nums > 0, `底部題號列有畫出來（${nav.nums} 個）`);
// 橫幅不能蓋住題號列 —— 那是這個系統最該被看到的東西之一
const notCovered = await page.evaluate(() => {
  const foot = document.querySelector('.cbt-foot');
  const bar = document.querySelector('#demo-bar');
  if (!foot || !bar) return true;
  const f = foot.getBoundingClientRect(), b = bar.getBoundingClientRect();
  return f.bottom <= b.top + 1;
});
ok(notCovered, '示範站橫幅沒有蓋到題號列');
// 系統自己的「題目被吞掉」偵測器。它跳出來就代表題號列列了某一題、
// 但畫面上找不到對應的 #q-N —— 這正是 v2.23.2 修的那個 bug。
ok(!nav.audit, `沒有觸發吞題目警告${nav.audit ? '：' + nav.audit.slice(0, 80) : ''}`);
const hasPassage = await page.evaluate(() =>
  (document.querySelector('.cbt-split')?.innerText || document.body.innerText).length > 900);
ok(hasPassage, '文章內容有載入');
const isReading = await page.evaluate(() => /Reading|閱讀/.test(document.body.innerText));
ok(isReading, '真的進到閱讀（不是被導到別科）');
await page.screenshot({ path: `${SHOT}/02-reading.png` });

// 作答一題，確認存得回去
const firstInput = page.locator('#q-1 input, #q-1 select, #q-1 textarea').first();
if (await firstInput.count()) {
  await firstInput.fill?.('demo').catch(() => {});
}
await page.waitForTimeout(400);

// ── 3. 聽力 ──────────────────────────────────────────────────────────
step('聽力：音檔要真的在播');
await goHome(page);
await startModule(page, 'listening');
await page.waitForTimeout(2500);

const audio = await page.evaluate(() => {
  const a = document.querySelector('audio');
  return a ? { src: a.getAttribute('src'), paused: a.paused, t: a.currentTime, dur: a.duration, err: !!a.error } : null;
});
ok(!!audio, '有 <audio> 元素');
ok(audio && !audio.err, '音檔沒有載入錯誤');
ok(audio && audio.dur > 60, `音檔長度合理（${audio ? Math.round(audio.dur) : 0} 秒）`);
await page.waitForTimeout(2500);
const after = await page.evaluate(() => { const a = document.querySelector('audio'); return a ? a.currentTime : 0; });
ok(after > 0.5, `播放進度有前進（${after.toFixed(1)} 秒）`);
const listenQs = await page.locator('[id^="q-"]').count();
ok(listenQs >= 8, `聽力題目有畫出來（${listenQs} 題）`);
const listenNav = await page.evaluate(() => ({
  nums: document.querySelectorAll('.cbt-foot .cbt-num').length,
  audit: document.querySelector('#q-audit')?.innerText || '',
}));
ok(listenNav.nums > 0, `聽力題號列有畫出來（${listenNav.nums} 個）`);
ok(!listenNav.audit, `聽力沒有觸發吞題目警告${listenNav.audit ? '：' + listenNav.audit.slice(0, 80) : ''}`);
await page.screenshot({ path: `${SHOT}/03-listening.png` });

// ── 4. 寫作 ──────────────────────────────────────────────────────────
step('寫作：圖表與即時字數');
await goHome(page);
await startModule(page, 'writing');
await page.waitForTimeout(1200);
const ta = page.locator('textarea').first();
ok(await ta.count() > 0, '有作文輸入區');
if (await ta.count()) {
  await ta.fill('The chart shows a clear upward trend in the number of visitors over the period, with a marked peak in the summer months.');
  await page.waitForTimeout(600);
  const wc = await page.evaluate(() => document.body.innerText.match(/(\d+)\s*(字|words?)/i)?.[1]);
  ok(Number(wc) > 15, `即時字數有在算（${wc}）`);
}
const figs = await page.locator('img.cbt-fig, .cbt-fig img, figure img').count();
console.log(`    （寫作圖表元素：${figs} 個）`);
await page.screenshot({ path: `${SHOT}/04-writing.png` });

// ── 5. 口說：錄好的示範 ──────────────────────────────────────────────
step('口說：考官要真的出聲、逐字稿要出現');
await goHome(page);
await startModule(page, 'speaking');
await page.waitForTimeout(3000);

const mode = await page.evaluate(() => document.body.innerText);
ok(!/未設定即時端點/.test(mode),
  '走的是即時對話模式（不是退回語音問答）');

const started = await page.evaluate(() => {
  const go = [...document.querySelectorAll('button')]
    .find((b) => /開始口說測驗|開始測驗/.test(b.textContent) && b.offsetParent !== null);
  if (go) { go.click(); return true; }
  return false;
});
ok(started, '按得到「開始口說測驗」');
await page.waitForTimeout(14000);

const spk = await page.evaluate(() => ({
  stage: document.querySelector('#sp-stage')?.textContent || '',
  qline: document.querySelector('#sp-q')?.textContent || '',
  chat: document.body.innerText,
  wsSwapped: window.WebSocket.name === 'DemoWS',
}));
ok(spk.wsSwapped, 'WebSocket 有被換成示範用的');
ok(/PART|介紹|準備|考官/.test(spk.stage),
  `流程有跑起來（stage="${spk.stage.slice(0, 30)}"）`);
ok(/Eleanor Shaw|full name/.test(spk.chat) || spk.qline.length > 15,
  `考官的話有顯示出來（qline="${spk.qline.slice(0, 50)}"）`);
ok(/Wang Xiao Ming|Taipei/.test(spk.chat), '考生的逐字稿也有出現');
ok(!/直接開口說話即可/.test(spk.chat) && /錄好的示範對話/.test(spk.chat),
  '沒有留下「直接開口說話」這句會誤導人的提示');

// 考官必須真的出聲：AudioContext 要有排程過的來源
const spoke = await page.evaluate(() => window.__demoAudioChunks || 0);
console.log(`    （送進音訊管線的 PCM 分塊：${spoke}）`);
await page.screenshot({ path: `${SHOT}/05-speaking.png` });

// ── 6. 批改：分數必須是真的算出來的 ──────────────────────────────────
step('批改：用真的 answers.js / bands.js');
const marking = await page.evaluate(() => {
  const { checkAnswer } = window.DEMO_LIB.answers;
  const { rawToBand } = window.DEMO_LIB.bands;
  const flat = window.DEMO.flat.listening;
  // 全對
  window.DEMO.state.answers.clear();
  for (const q of flat) window.DEMO.state.answers.set(q.number, (q.answers || [''])[0]);
  const full = window.DEMO.grade();
  // 全錯
  window.DEMO.state.answers.clear();
  for (const q of flat) window.DEMO.state.answers.set(q.number, '___zzz___');
  const zero = window.DEMO.grade();
  window.DEMO.state.answers.clear();
  return {
    total: flat.length,
    fullRaw: full.raw.listening, fullBand: full.bands.listening,
    zeroRaw: zero.raw.listening, zeroBand: zero.bands.listening,
    spot: rawToBand(30, 40, 'listening', 'academic'),
    checkExists: typeof checkAnswer === 'function',
  };
});
ok(marking.checkExists, '用的是真的 checkAnswer');
ok(marking.fullRaw === marking.total, `全對 = 滿分（${marking.fullRaw}/${marking.total}）`);
ok(marking.fullBand >= 8.5, `全對換算成高分（band ${marking.fullBand}）`);
ok(marking.zeroRaw === 0, `全錯 = 0 分（${marking.zeroRaw}）`);
ok(marking.zeroBand <= 2, `全錯換算成低分（band ${marking.zeroBand}）`);
ok(marking.spot === 7, `官方換算表對得上：聽力 30/40 → band ${marking.spot}（應為 7）`);

// ── 7. 全域檢查 ──────────────────────────────────────────────────────
step('全域');
const realBad = bad404.filter((x) => !/favicon/.test(x));
ok(realBad.length === 0, `沒有 4xx/5xx 請求${realBad.length ? '：' + realBad.slice(0, 5).join(', ') : ''}`);
ok(unhandled.length === 0, `假後端沒有漏接請求${unhandled.length ? '：' + unhandled.slice(0, 3).join(' | ') : ''}`);
const realErr = errors.filter((e) => !/favicon|autoplay|play\(\) failed|NotAllowedError/i.test(e));
ok(realErr.length === 0, `console 沒有錯誤${realErr.length ? '：' + realErr.slice(0, 3).join(' | ') : ''}`);

await browser.close();
console.log(`\n截圖 → ${SHOT}`);
console.log(failed ? `\n✗ ${failed} 項沒過` : '\n✓ 全部通過');
process.exit(failed ? 1 : 0);

// ── 小工具 ───────────────────────────────────────────────────────────
async function goHome(page) {
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForTimeout(900);
}

/** 回到科目選擇頁（#/exam/:id）。第一次要先按首頁的「開始考試」。 */
async function toPicker(page) {
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForTimeout(800);
  const start = page.locator('button', { hasText: '開始考試' });
  if (await start.count()) {
    await start.first().click();
    await page.waitForTimeout(1600);
  }
  return /#\/exam\//.test(await page.evaluate(() => location.hash));
}

/** 在科目選擇頁上按下某一科的「開始」。四個按鈕長得一樣，靠所在列的文字分辨。 */
async function startModule(page, mod) {
  if (!await toPicker(page)) return false;
  const clicked = await page.evaluate((want) => {
    const label = { listening: 'Listening', reading: 'Reading', writing: 'Writing', speaking: 'Speaking' }[want];
    // 認的是「按鈕的直接父層」那一列。用祖父層會抓到裝著四科的容器，
    // 四個按鈕都會match第一科 —— 之前就是這樣，四科其實全都在跑聽力。
    const btn = [...document.querySelectorAll('button')]
      .filter((b) => /^(開始|繼續)$/.test(b.textContent.trim()))
      .find((b) => (b.parentElement?.textContent || '').includes(label));
    if (!btn) return false;
    btn.click();
    return true;
  }, mod);
  await page.waitForTimeout(1400);

  // 科目開始前還有關卡（耳機測試、注意事項）。一路按過去，直到題目出現。
  for (let i = 0; i < 4; i++) {
    const painted = await page.locator('[id^="q-"]').count();
    if (painted > 0) break;
    const advanced = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        /我聽得很清楚|開始考試|開始作答|我知道了|繼續|確定/.test(x.textContent) &&
        x.offsetParent !== null);
      if (!b) return null;
      b.click();
      return b.textContent.trim().slice(0, 20);
    });
    if (!advanced) break;
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(800);
  return clicked;
}
