/* 考卷裡的圖表會不會爆版、變形、看不清楚。
 *
 * 學生回報「有圖表的題目，圖表整個都出問題（比例不對／無法閱讀／
 * 超出視窗大小範圍）」。成因是只有 `.cbt-group img.fig` 那一條 CSS 有
 * max-width，而**寫作 Task 1 的圖表不在 .cbt-group 裡面** —— 於是完全
 * 沒有任何寬度限制。實測一張 1600×900 的長條圖原尺寸畫出來，右邊超出
 * 容器 981px、下面超出視窗 276px：學生看得到的只有左上角兩根長條，
 * 沒有年份、沒有圖例、沒有單位，這一題根本沒辦法作答。
 *
 * 這一支用真實尺寸的圖（超寬、超高、很小）在三種視窗大小下量實際渲染
 * 結果 —— 這種問題只有真的畫出來才量得到。
 *
 *   node test/browser/figures.mjs
 */
import { chromium } from './_pw.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const B = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(m, p, b, t) {
  const h = {}; if (t) h.authorization = `Bearer ${t}`; if (b) h['content-type'] = 'application/json';
  const r = await fetch(B + '/api' + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
let bad = 0;
const ok = (c, label, extra = '') => { console.log(`  ${c ? '✓' : '✗'} ${label}${extra ? `　${extra}` : ''}`); if (!c) bad += 1; };

/* 測試用的圖：故意做成真實試卷會有的尺寸。
   用 Python/PIL 生（專案本來就沒有影像相依套件，也不該為了測試加一個）。 */
const IMGDIR = path.resolve('uploads/image');
const FIGS = { wide: [1600, 900], tall: [900, 2200], small: [360, 240] };
function makeImages() {
  const missing = Object.keys(FIGS).filter((k) => !fs.existsSync(path.join(IMGDIR, `zqxfig_${k}.png`)));
  if (!missing.length) return true;
  const py = `
from PIL import Image, ImageDraw
import os
os.makedirs(${JSON.stringify(IMGDIR)}, exist_ok=True)
for name,(w,h) in ${JSON.stringify(FIGS)}.items():
    im=Image.new('RGB',(w,h),'white'); d=ImageDraw.Draw(im)
    m=int(min(w,h)*0.12)
    d.rectangle([m,m,w-m,h-m], outline='black', width=max(1,w//600))
    for i in range(5):
        x=m+(w-2*m)*i//5
        d.rectangle([x+8, h-m-(h-2*m)*(i+2)//8, x+(w-2*m)//8, h-m], fill=(30+i*40,90,150))
    im.save(os.path.join(${JSON.stringify(IMGDIR)}, 'zqxfig_'+name+'.png'))
print('ok')`;
  try { execFileSync('python3', ['-c', py], { stdio: ['ignore', 'pipe', 'pipe'] }); return true; }
  catch (e) { console.error('產生測試圖失敗（需要 python3 + Pillow）：', String(e.message).slice(0, 120)); return false; }
}
if (!makeImages()) process.exit(2);
const IMG = (k) => `/uploads/image/zqxfig_${k}.png`;

const adm = (await call('POST', '/auth/login', { username: 'admin', password: 'admin1234' })).data.token;
const tea = (await call('POST', '/auth/login', { username: 'teacher1', password: 'teach1234' })).data;
const stu = (await call('POST', '/auth/login', { username: 'student1', password: 'ielts1234' })).data;

/* 兩份分開的試卷、兩個 attempt。同一份試卷裡的科目有作答順序限制，
   混在一起測會被休息政策擋住 —— 那不是這一支要驗的東西。 */
const PAPERS = {
  writing: { title: `圖表-寫作 ${Date.now()}`, testType: 'academic', modules: [
    { module: 'writing', durationSec: 3600, sections: [{ title: 'Task 1', groups: [{ type: 'writing_task',
      questions: [{ taskNo: 1, number: 1, minWords: 150, image: IMG('wide'),
        prompt: 'The chart below shows household energy use.' }] }] }] }] },
  reading: { title: `圖表-閱讀 ${Date.now()}`, testType: 'academic', modules: [
    { module: 'reading', durationSec: 3600, sections: [{ title: 'Passage 1',
      passage: '<p>Recycling paper takes several stages.</p>', image: IMG('tall'),
      groups: [{ type: 'mcq_single', instructions: 'Look at the diagram.', image: IMG('small'),
        questions: [{ number: 1, text: 'Which stage comes first?',
          options: [{ key: 'A', text: 'Pulping' }, { key: 'B', text: 'Sorting' }], answers: ['B'] }] }] }] }] },
};
const made = [];
const ATT = {};
for (const [mod, paper] of Object.entries(PAPERS)) {
  const t = await call('POST', '/tests', { paper }, tea.token);
  if (t.status !== 200) { console.error('建卷失敗', JSON.stringify(t.data).slice(0, 300)); process.exit(2); }
  const asg = await call('POST', '/tests/assignments',
    { testId: t.data.id, userIds: [stu.user.id], modules: mod, maxAttempts: 9 }, tea.token);
  const st = await call('POST', '/exam/start', { assignmentId: asg.data.ids[0], testId: t.data.id }, stu.token);
  ATT[mod] = st.data.attemptId;
  made.push({ testId: t.data.id, asgId: asg.data.ids[0], at: st.data.attemptId });
}
const cleanup = async () => {
  for (const m of made) {
    await call('DELETE', `/tests/assignments/${m.asgId}`, null, tea.token);
    await call('POST', '/manage/results/bulk', { action: 'delete', ids: [m.at], force: true }, adm);
    await call('DELETE', `/tests/${m.testId}`, { force: true }, adm);
  }
};

const br = await chromium.launch({ args: ['--no-sandbox'] });
async function open(viewport, at) {
  const ctx = await br.newContext({ viewport });
  const pg = await ctx.newPage();
  await pg.goto(B);
  // /uploads 需要 httpOnly cookie，所以要真的登入
  await pg.evaluate(async () => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'student1', password: 'ielts1234' }) });
    const j = await r.json();
    localStorage.setItem('ielts_token', j.token); localStorage.setItem('ielts_user', JSON.stringify(j.user));
  });
  await pg.goto(`${B}/#/exam/${at}`); await pg.reload(); await sleep(2600);
  return { ctx, pg };
}
async function into(pg, want) {
  for (let i = 0; i < 12; i++) {
    if (await pg.$(want === 'writing' ? 'textarea' : '#q-1')) return true;
    const hit = await pg.evaluate((w) => {
      const re = w === 'writing' ? /寫作|Writing/ : /閱讀|Reading/;
      /* 科目清單是「一列一科」：標題在 <b> 裡，按鈕寫的是「開始／繼續作答」。
         所以要先找到那一列，再按那一列裡的按鈕 —— 直接找按鈕文字會永遠
         按到清單上的第一科。 */
      const rows = [...document.querySelectorAll('div, li, tr')]
        .filter((r) => re.test(r.textContent) && r.querySelector('button'));
      const row = rows[rows.length - 1];
      const inRow = row && [...row.querySelectorAll('button')]
        .find((b) => !b.disabled && b.offsetWidth && /開始|繼續作答/.test(b.textContent));
      if (inRow) { inRow.click(); return true; }
      const bs = [...document.querySelectorAll('button')].filter((b) => !b.disabled && b.offsetWidth);
      const f = bs.find((b) => /^(資料正確|繼續|進入|我聽得很清楚)/.test(b.textContent.trim()) && !/離開/.test(b.textContent));
      if (f) { f.click(); return true; }
      return false;
    }, want);
    await sleep(1500);
    if (!hit) break;
  }
  return !!(await pg.$(want === 'writing' ? 'textarea' : '#q-1'));
}
const measure = (pg) => pg.evaluate(() => [...document.querySelectorAll('.cbt-fig')].map((img) => {
  const r = img.getBoundingClientRect();
  const host = img.closest('.cbt-pane, .cbt-center') || document.body;
  const hr = host.getBoundingClientRect();
  const nat = img.naturalWidth / img.naturalHeight;
  const shown = r.height ? r.width / r.height : nat;
  return {
    原始: `${img.naturalWidth}×${img.naturalHeight}`,
    顯示: `${Math.round(r.width)}×${Math.round(r.height)}`,
    比例偏差pct: Math.round(Math.abs(shown - nat) / nat * 100),
    超出容器右邊: Math.round(r.right - hr.right),
    超出視窗下方: Math.round(r.bottom - innerHeight),
    容器橫向捲動: host.scrollWidth > host.clientWidth + 2,
    縮放pct: Math.round(r.width / img.naturalWidth * 100),
  };
}));

for (const vp of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 820, height: 1100 }]) {
  for (const mod of ['writing', 'reading']) {
    const { ctx, pg } = await open(vp, ATT[mod]);
    if (!(await into(pg, mod))) { ok(false, `${vp.width}px · ${mod} 進得去`); await ctx.close(); continue; }
    await sleep(1200);
    const figs = await measure(pg);
    console.log(`\n【${vp.width}×${vp.height} · ${mod}】`);
    if (!figs.length) { ok(false, '看得到圖'); continue; }
    for (const f of figs) {
      console.log(`   ${f.原始} → ${f.顯示}（${f.縮放pct}%）`);
      ok(f.超出容器右邊 <= 2, '沒有超出容器右邊', `${f.超出容器右邊}px`);
      ok(!f.容器橫向捲動, '沒有橫向捲軸');
      ok(f.超出視窗下方 <= 2, '沒有超出視窗下方', `${f.超出視窗下方}px`);
      ok(f.比例偏差pct <= 2, '比例沒有跑掉', `${f.比例偏差pct}%`);
    }
    await ctx.close();
  }
}

console.log('\n【放大檢視】');
{
  const { ctx, pg } = await open({ width: 1280, height: 800 }, ATT.writing);
  await into(pg, 'writing'); await sleep(1000);
  const inline = (await measure(pg))[0];
  await pg.evaluate(() => document.querySelector('.cbt-fig')?.click());
  await sleep(700);
  const lb = await pg.evaluate(() => {
    const b = document.querySelector('.cbt-lightbox');
    if (!b) return null;
    const img = b.querySelector('img'); const r = img.getBoundingClientRect();
    const nat = img.naturalWidth / img.naturalHeight;
    return {
      掛在body: b.parentElement === document.body,
      帶cbt: b.classList.contains('cbt'),
      縮放pct: Math.round(r.width / img.naturalWidth * 100),
      比例偏差pct: Math.round(Math.abs(r.width / r.height - nat) / nat * 100),
      在視窗內: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
    };
  });
  if (!lb) { ok(false, '點圖片會打開放大檢視'); }
  else {
    ok(lb.掛在body, '掛在 body（重畫不會把它連根拔掉）');
    ok(lb.帶cbt, '帶著 cbt，配色變數吃得到');
    ok(lb.在視窗內, '沒有超出視窗');
    ok(lb.比例偏差pct <= 2, '比例沒有跑掉', `${lb.比例偏差pct}%`);
    ok(lb.縮放pct > inline.縮放pct, '比內嵌時大得多（這才是「看得清楚」的關鍵）',
      `${inline.縮放pct}% → ${lb.縮放pct}%`);
  }
  await pg.evaluate(() => {
    const p = [...document.querySelectorAll('.cbt-lightbox .bar button')].find((b) => b.textContent.trim() === '＋');
    p.click(); p.click();
  });
  await sleep(400);
  const z = await pg.evaluate(() => {
    const i = document.querySelector('.cbt-lightbox img');
    return Math.round(i.getBoundingClientRect().width / i.naturalWidth * 100);
  });
  ok(z > 100, '可以放大到原始尺寸以上（座標軸的字才看得清楚）', `${z}%`);

  await pg.keyboard.press('Escape'); await sleep(400);
  ok(!(await pg.evaluate(() => !!document.querySelector('.cbt-lightbox'))), 'Esc 關得掉');
  ok(!!(await pg.$('textarea')), '關掉之後底下的考卷完好');

  // 分隔線：以前寫作這根沒有 id，看起來可以拖但完全拖不動
  const box = await pg.evaluate(() => {
    const sp = document.querySelector('#splitter');
    if (!sp) return null;
    const r = sp.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      left: Math.round(document.querySelector('#pane-passage').getBoundingClientRect().width) };
  });
  ok(!!box, '寫作也有可以拖的分隔線');
  if (box) {
    await pg.mouse.move(box.x, box.y); await pg.mouse.down();
    await pg.mouse.move(box.x - 200, box.y, { steps: 10 }); await pg.mouse.up();
    await sleep(400);
    const after = await pg.evaluate(() => Math.round(document.querySelector('#pane-passage').getBoundingClientRect().width));
    ok(Math.abs(after - box.left) > 80, '真的拖得動', `${box.left} → ${after}px`);
  }
  await pg.screenshot({ path: '/tmp/figures.png' });
  await ctx.close();
}

await br.close();
await cleanup();
console.log(bad ? `\n✗ ${bad} 項不合格\n` : '\n✓ 圖表全部正常\n');
process.exit(bad ? 1 : 0);
