/* 產生 README 用的截圖。
 *
 * 不是測試 —— 是把真的畫面拍下來。手動截圖很快就會過期（改了版面、
 * 改了配色、加了功能，README 上的圖還停在半年前），所以做成腳本，
 * 需要的時候重跑一次就好。
 *
 *   node test/browser/screenshots.mjs
 *
 * 輸出到 docs/screenshots/。
 */
import { chromium } from './_pw.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const B = process.env.BASE || 'http://localhost:3000';
const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(m, p, b, t) {
  const h = {}; if (t) h.authorization = `Bearer ${t}`; if (b) h['content-type'] = 'application/json';
  const r = await fetch(B + '/api' + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const shots = [];
const shot = async (pg, name, desc) => {
  const f = path.join(OUT, `${name}.png`);
  await pg.screenshot({ path: f });
  shots.push({ name, desc });
  console.log(`  ✓ ${name}.png　${desc}`);
};

// ── 素材：一張 Task 1 圖表、一段測試音 ────────────────────
const IMGDIR = path.resolve('uploads/image');
const AUDDIR = path.resolve('uploads/audio');
fs.mkdirSync(IMGDIR, { recursive: true }); fs.mkdirSync(AUDDIR, { recursive: true });
if (!fs.existsSync(path.join(IMGDIR, 'demo_chart.png'))) {
  execFileSync('python3', ['-c', `
from PIL import Image, ImageDraw
w,h=1400,820
im=Image.new('RGB',(w,h),'white'); d=ImageDraw.Draw(im)
m=110
d.text((m,40),'Household energy use by source, 2010-2020 (%)',fill='black')
d.line([m,h-m,w-60,h-m],fill='black',width=3); d.line([m,60,m,h-m],fill='black',width=3)
vals=[[42,55,61,68,74],[58,45,39,32,26]]
cols=[(31,92,140),(176,74,110)]
years=['2010','2013','2016','2018','2020']
bw=(w-m-90)//(len(years)*3)
for s,row in enumerate(vals):
    for i,v in enumerate(row):
        x=m+30+i*bw*3+s*bw
        bh=int((h-m-70)*v/100)
        d.rectangle([x,h-m-bh,x+bw-6,h-m],fill=cols[s])
for i,y in enumerate(years):
    d.text((m+40+i*bw*3,h-m+14),y,fill='black')
for j in range(6):
    yy=h-m-(h-m-70)*j//5
    d.line([m-8,yy,m,yy],fill='black',width=2); d.text((m-52,yy-7),f'{j*20}%',fill='black')
d.rectangle([w-330,70,w-310,90],fill=cols[0]); d.text((w-300,72),'Electricity',fill='black')
d.rectangle([w-330,102,w-310,122],fill=cols[1]); d.text((w-300,104),'Gas',fill='black')
im.save('${'${IMGDIR}'}'.replace('$'+'{IMGDIR}','${IMGDIR}')+'/demo_chart.png')
`.replace('${IMGDIR}', IMGDIR)], { stdio: ['ignore', 'pipe', 'pipe'] });
}
if (!fs.existsSync(path.join(AUDDIR, 'demo_tone.mp3'))) {
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=120',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-y', path.join(AUDDIR, 'demo_tone.mp3')],
  { stdio: ['ignore', 'pipe', 'pipe'] });
}

const adm = (await call('POST', '/auth/login', { username: 'admin', password: 'admin1234' })).data.token;
const tea = (await call('POST', '/auth/login', { username: 'teacher1', password: 'teach1234' })).data;
const stu = (await call('POST', '/auth/login', { username: 'student1', password: 'ielts1234' })).data;
if (!adm || !tea.token || !stu.token) { console.error('請先 npm run seed'); process.exit(2); }

const PASSAGE = `<p>For most of the twentieth century, city planners treated trees as decoration. Streets were widened,
canopies were cut back, and the shade that had once made summer afternoons bearable disappeared under
asphalt. Only in the last two decades has that calculation been revisited, and the reason is not
aesthetic but thermal: a mature street tree can lower the surface temperature beneath it by as much as
twelve degrees.</p>
<p>The economics have shifted too. Municipal accountants who once recorded trees purely as a maintenance
liability now list them alongside drainage and road surfacing, because a canopy that intercepts rainfall
reduces the load on storm sewers. In Melbourne, where the urban forest strategy aims to double canopy
cover by 2040, the programme is funded partly from the drainage budget rather than from parks.</p>
<p>Resistance persists. Residents complain about leaf litter, root damage and obstructed views, and
utilities object to planting near cables. Planners have learned to answer these objections with data
rather than sentiment — which is why the most successful schemes begin not with saplings but with a
survey.</p>`;

const paper = {
  title: 'IELTS Academic Practice Test (demo)', testType: 'academic',
  modules: [
    { module: 'listening', durationSec: 1800, sections: [{
      title: 'Section 1', audio: '/uploads/audio/demo_tone.mp3',
      groups: [
        { type: 'gap_fill', instructions: 'Complete the form below. Write NO MORE THAN TWO WORDS AND/OR A NUMBER for each answer.',
          bodyHtml: `<h4>COMMUNITY CENTRE — MEMBERSHIP FORM</h4><table>
            <tr><th>Name</th><td>Helen [[1]]</td></tr>
            <tr><th>Address</th><td>[[2]] Road, Northfield</td></tr>
            <tr><th>Membership type</th><td>[[3]]</td></tr>
            <tr><th>Annual fee</th><td>£[[4]]</td></tr></table>`,
          questions: [{ number: 1, text: '', answers: ['Whitaker'] }, { number: 2, text: '', answers: ['42'] },
            { number: 3, text: '', answers: ['family'] }, { number: 4, text: '', answers: ['85'] }] },
        { type: 'mcq_single', instructions: 'Choose the correct letter, A, B or C.',
          questions: [
            { number: 5, text: 'The centre is closed on', options: [{ key: 'A', text: 'Mondays.' }, { key: 'B', text: 'Sundays.' }, { key: 'C', text: 'public holidays only.' }], answers: ['B'] },
            { number: 6, text: 'Members can book a room', options: [{ key: 'A', text: 'up to two weeks ahead.' }, { key: 'B', text: 'only in person.' }, { key: 'C', text: 'through the website.' }], answers: ['C'] }] },
      ] }] },
    { module: 'reading', durationSec: 3600, sections: [{
      title: 'Passage 1', passageTitle: 'The return of the urban forest', passage: PASSAGE,
      groups: [
        { type: 'tfng', instructions: 'Do the following statements agree with the information given in the passage?',
          questions: [
            { number: 1, text: 'City planners in the twentieth century valued trees mainly for their appearance.', answers: ['TRUE'] },
            { number: 2, text: 'A mature street tree can reduce the surface temperature below it.', answers: ['TRUE'] },
            { number: 3, text: 'Melbourne funds its canopy programme entirely from the parks budget.', answers: ['FALSE'] }] },
        { type: 'matching', instructions: 'Match each objection with the group that raises it.',
          optionsTitle: 'List of groups',
          options: [{ key: 'A', text: 'Residents' }, { key: 'B', text: 'Utility companies' }, { key: 'C', text: 'Municipal accountants' }],
          questions: [
            { number: 4, text: 'damage caused by roots', answers: ['A'] },
            { number: 5, text: 'planting close to cables', answers: ['B'] }] },
      ] }] },
    { module: 'writing', durationSec: 3600, sections: [
      { title: 'Task 1', groups: [{ type: 'writing_task', questions: [{
        taskNo: 1, number: 1, minWords: 150, image: '/uploads/image/demo_chart.png',
        prompt: '<p>The chart below shows household energy use by source between 2010 and 2020.</p><p>Summarise the information by selecting and reporting the main features, and make comparisons where relevant.</p>' }] }] },
      { title: 'Task 2', groups: [{ type: 'writing_task', questions: [{
        taskNo: 2, number: 2, minWords: 250,
        prompt: '<p>Some people believe that cities should spend more on planting trees than on building new roads. To what extent do you agree or disagree?</p>' }] }] },
    ] },
  ],
};

/* 一科一份試卷。
   exam/start 對同一份試卷只會回傳同一個 attempt（就算指派不同也一樣），
   所以想同時停在三個科目的畫面上，只能拆成三份試卷。 */
console.log('\n建立示範試卷…');
const TESTS = {}; const ASG = {}; const AT = {};
for (const mod of ['listening', 'reading', 'writing']) {
  const one = { ...paper, title: `${paper.title} — ${mod}`,
    modules: paper.modules.filter((m) => m.module === mod) };
  const r = await call('POST', '/tests', { paper: one }, tea.token);
  if (r.status !== 200) { console.error(`${mod} 建卷失敗`, JSON.stringify(r.data).slice(0, 300)); process.exit(2); }
  TESTS[mod] = r.data.id;
  const a = await call('POST', '/tests/assignments',
    { testId: r.data.id, userIds: [stu.user.id], modules: mod, maxAttempts: 9 }, tea.token);
  ASG[mod] = a.data.ids[0];
  const s0 = await call('POST', '/exam/start', { assignmentId: ASG[mod], testId: r.data.id }, stu.token);
  AT[mod] = s0.data.attemptId;
}
console.log('  attempt:', JSON.stringify(AT));

const br = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const VP = { width: 1440, height: 900 };
async function asUser(username, password) {
  const ctx = await br.newContext({ viewport: VP, deviceScaleFactor: 2 });
  const pg = await ctx.newPage();
  await pg.goto(B);
  await pg.evaluate(async ([u, p]) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }) });
    const j = await r.json();
    localStorage.setItem('ielts_token', j.token); localStorage.setItem('ielts_user', JSON.stringify(j.user));
  }, [username, password]);
  return { ctx, pg };
}
const clickText = (pg, re) => pg.evaluate((src) => {
  const rx = new RegExp(src);
  const b = [...document.querySelectorAll('button, a.btn')]
    .filter((x) => !x.disabled && x.offsetWidth).find((x) => rx.test(x.textContent.trim()));
  if (b) { b.click(); return true; }
  return false;
}, re.source ?? re);

console.log('\n學生端：');
{
  const { ctx, pg } = await asUser('student1', 'ielts1234');
  let at = AT.reading;

  // 科目清單
  await pg.goto(`${B}/#/exam/${at}`); await pg.reload(); await sleep(2600);
  await clickText(pg, /^資料正確/); await sleep(1600);
  await shot(pg, '01-modules', '科目清單：一次考一科、進度與次數一目了然');


  // 閱讀
  /* 每次換科目都要重新載入。hash 沒變的話 SPA 不會重畫，會停在上一科 ——
     第一版就是這樣，寫作那張截到的其實是閱讀畫面。 */
  const enter = async (label, want, attempt) => {
    if (attempt) at = attempt;
    await pg.goto(`${B}/#/exam/${at}`);
    await pg.reload();
    await sleep(2600);
    await clickText(pg, /^(資料正確|繼續)/);
    await sleep(1600);
    for (let i = 0; i < 8; i++) {
      if (await pg.$(want)) return true;
      const done = await pg.evaluate((l) => {
        const rows = [...document.querySelectorAll('div')]
          .filter((r) => new RegExp(l).test(r.textContent) && r.querySelector('button'));
        const row = rows[rows.length - 1];
        const b = row && [...row.querySelectorAll('button')]
          .find((x) => /開始|繼續作答/.test(x.textContent) && !x.disabled && x.offsetWidth);
        if (b) { b.click(); return true; }
        const f = [...document.querySelectorAll('button')]
          .find((x) => /^(繼續|開始|我聽得很清楚)/.test(x.textContent.trim()) && !x.disabled && x.offsetWidth);
        if (f) { f.click(); return true; }
        return false;
      }, label);
      await sleep(1700);
      if (!done) break;
    }
    const got = !!(await pg.$(want));
    if (!got) {
      console.log(`  ⚠ 進不去「${label}」，畫面是：`,
        (await pg.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 140));
    }
    return got;
  };
  await enter('閱讀|Reading', '#q-1', AT.reading); await sleep(1400);
  // 作答一點、畫一條螢光筆，畫面才像真的在考試
  await pg.evaluate(() => {
    document.querySelector('#q-1 label.cbt-opt')?.click();
    document.querySelector('#q-2 label.cbt-opt')?.click();
    const p = document.querySelectorAll('.cbt-passage p')[1];
    if (p?.firstChild) {
      const r = document.createRange();
      r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, Math.min(120, p.firstChild.length));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  });
  await sleep(500);
  await pg.evaluate(() => {
    const p = document.querySelectorAll('.cbt-passage p')[1];
    p?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 340 }));
  });
  await sleep(500);
  await pg.evaluate(() => {
    const b = [...document.querySelectorAll('.cbt-menu button')].find((x) => /Highlight/.test(x.textContent));
    if (b) b.click();
  });
  await sleep(900);
  await shot(pg, '02-reading', '閱讀：左文章右題目、可拖曳分隔線、螢光筆與註記');

  // 聽力
  await enter('聽力|Listening', '.cbt-gap', AT.listening); await sleep(1800);
  await pg.evaluate(() => {
    const gaps = [...document.querySelectorAll('.cbt-gap')];
    ['Whitaker', '42', 'family'].forEach((v, i) => {
      if (gaps[i]) { gaps[i].value = v; gaps[i].dispatchEvent(new Event('input', { bubbles: true })); }
    });
    document.querySelector('#q-5 label.cbt-opt')?.click();
  });
  await sleep(900);
  await shot(pg, '03-listening', '聽力：音檔只播一次、表單式填空、底部題號列即時反映作答狀態');

  // 寫作
  await enter('寫作|Writing', 'textarea', AT.writing); await sleep(1800);
  await pg.evaluate(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return;
    ta.value = 'The chart compares household energy use by source over a ten-year period. '
      + 'Overall, electricity became the dominant source, rising steadily from 42% in 2010 to 74% in 2020, '
      + 'while gas fell by more than half over the same period.\n\n'
      + 'In 2010 gas accounted for the larger share at 58%, but the two sources converged by 2013 and '
      + 'crossed shortly afterwards.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(1200);
  await shot(pg, '04-writing', '寫作 Task 1：圖表可放大檢視、即時字數、左右欄寬可調');

  // 放大檢視
  await pg.evaluate(() => document.querySelector('.cbt-fig')?.click());
  await sleep(900);
  await shot(pg, '05-figure-zoom', '圖表放大檢視：可縮放、可拖曳，座標軸看得清楚');
  await pg.keyboard.press('Escape'); await sleep(400);

  // 高對比配色（無障礙）
  await pg.evaluate(() => {
    localStorage.setItem('ielts_cbt_prefs', JSON.stringify({ scheme: 'yellow-black', size: 'large' }));
  });
  await enter('閱讀|Reading', '#q-1', AT.reading); await sleep(1600);
  await shot(pg, '06-high-contrast', '官方同款的字級與高對比配色（黑底黃字／大字）');

  await ctx.close();
}

console.log('\n教師端：');
{
  const { ctx, pg } = await asUser('teacher1', 'teach1234');
  for (const [hash, name, desc] of [
    ['#/admin', '07-admin-overview', '教師端：成績總覽'],
    ['#/admin/tests', '08-admin-tests', '試卷管理：一眼看出哪份試卷「學生會開天窗」'],
    ['#/admin/members', '09-admin-members', '成員管理：老師可指定管轄班級（不指定＝全校）'],
  ]) {
    await pg.goto(`${B}/${hash}`); await pg.reload(); await sleep(2800);
    await shot(pg, name, desc);
  }
  await ctx.close();
}

await br.close();
for (const mod of Object.keys(TESTS)) {
  await call('DELETE', `/tests/assignments/${ASG[mod]}`, null, tea.token);
  await call('POST', '/manage/results/bulk', { action: 'delete', ids: [AT[mod]], force: true }, adm);
  await call('DELETE', `/tests/${TESTS[mod]}`, { force: true }, adm);
}

fs.writeFileSync(path.join(OUT, 'INDEX.md'),
  '# Screenshots\n\n由 `node test/browser/screenshots.mjs` 產生，改版之後重跑即可。\n\n'
  + shots.map((s) => `- \`${s.name}.png\` — ${s.desc}`).join('\n') + '\n');
console.log(`\n共 ${shots.length} 張 → docs/screenshots/\n`);
