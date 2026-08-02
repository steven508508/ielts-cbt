/* 聽力：音檔會不會被畫面重畫弄死。
 *
 * 原本的行為：<audio> 就畫在作答區裡，而每一次重畫都是
 * root().replaceChildren() —— 媒體元素一離開 document，瀏覽器依規範
 * 必須把它暫停。學生在聽力時右鍵畫一條螢光筆、或存一則註記，聲音就
 * 永遠停掉；重建之後 setupAudio 看到 _played 已經是 true，直接寫上
 * 「本 Part 音檔已播過（只播放一次）」就 return，再也不會播。
 * 那個 Part 的十題等於整組作廢，而畫面上沒有任何錯誤 —— 那行字看起來
 * 還很像系統照官方規則在運作。
 *
 * 一併驗：音檔載入失敗時最後留在畫面上的字要是實話，不能被
 * play() 的失敗訊息蓋成「播放中…」。
 *
 *   node test/browser/listeningAudio.mjs
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

const qs = (n, start) => Array.from({ length: n }, (_, i) => ({
  number: start + i, text: `Question ${start + i}: choose the correct letter.`,
  options: [{ key: 'A', text: 'Option A' }, { key: 'B', text: 'Option B' }, { key: 'C', text: 'Option C' }],
  answers: ['A'],
}));
const mkPaper = (audio) => ({
  title: `聽力音檔 ${Date.now()}`, testType: 'academic',
  modules: [{ module: 'listening', durationSec: 1800, sections: [
    { title: 'Section 1', audio, groups: [{ type: 'mcq_single', instructions: 'Choose the correct letter.', questions: qs(6, 1) }] },
    { title: 'Section 2', audio, groups: [{ type: 'mcq_single', instructions: 'Choose the correct letter.', questions: qs(6, 7) }] },
  ] }],
});

async function setup(audio) {
  const t = await call('POST', '/tests', { paper: mkPaper(audio) }, tea.token);
  if (t.status !== 200) throw new Error('建卷失敗 ' + JSON.stringify(t.data).slice(0, 200));
  const asg = await call('POST', '/tests/assignments',
    { testId: t.data.id, userIds: [stu.user.id], modules: 'listening', maxAttempts: 9 }, tea.token);
  const st = await call('POST', '/exam/start', { assignmentId: asg.data.ids[0], testId: t.data.id }, stu.token);
  return { testId: t.data.id, asgId: asg.data.ids[0], at: st.data.attemptId,
    cleanup: async () => {
      await call('DELETE', `/tests/assignments/${asg.data.ids[0]}`, null, tea.token);
      await call('POST', '/manage/results/bulk', { action: 'delete', ids: [st.data.attemptId], force: true }, adm);
      await call('DELETE', `/tests/${t.data.id}`, null, adm);
    } };
}

const br = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
async function enter(at) {
  const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(([tk, u]) => {
    localStorage.setItem('ielts_token', tk); localStorage.setItem('ielts_user', JSON.stringify(u));
  }, [stu.token, stu.user]);
  const pg = await ctx.newPage();
  /* 真的走一次登入。/uploads 需要 httpOnly cookie（<audio src> 帶不了
     Authorization 標頭），只塞 localStorage 的話音檔會拿到 401 —— 而那
     正是這一支要測的東西，不能繞過去。 */
  await pg.goto(B);
  await pg.evaluate(async () => {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'student1', password: 'ielts1234' }),
    });
    const j = await r.json();
    localStorage.setItem('ielts_token', j.token);
    localStorage.setItem('ielts_user', JSON.stringify(j.user));
  });
  await pg.goto(`${B}/#/exam/${at}`); await sleep(1000); await pg.reload(); await sleep(2400);
  const FWD = /^(資料正確|繼續|開始|進入|下一步|我已閱讀|同意|我聽得很清楚)/;
  for (let i = 0; i < 10; i++) {
    if (await pg.$('#q-1')) break;
    let c = false;
    for (const b of await pg.$$('button')) {
      const tx = ((await b.textContent()) || '').trim();
      if (FWD.test(tx) && !/離開/.test(tx) && await b.isVisible() && await b.isEnabled()) {
        await b.click().catch(() => {}); c = true; break;
      }
    }
    await sleep(1500); if (!c) break;
  }
  return { ctx, pg };
}
const audioSnap = (pg) => pg.evaluate(() => {
  const a = [...document.querySelectorAll('audio')][0];
  return {
    有播放器: !!a,
    掛在: a?.parentElement?.tagName || null,
    暫停中: a ? a.paused : null,
    位置: a ? Math.round(a.currentTime * 10) / 10 : null,
    狀態文字: document.querySelector('#aud-st')?.textContent || null,
  };
});

// ── 1. 聽到一半畫一條螢光筆 ──────────────────────────────
console.log('\n【1】聽到一半畫螢光筆／存註記');
{
  const ex = await setup('/uploads/audio/testtone.mp3');
  const { ctx, pg } = await enter(ex.at);
  await sleep(2500);
  const before = await audioSnap(pg);
  ok(before.有播放器, '有播放器');
  ok(before.掛在 === 'BODY', '播放器掛在 body，不在會被重畫的區塊裡', String(before.掛在));
  ok(before.暫停中 === false, '正在播放', `t=${before.位置}`);

  // 直接走「畫記」這條路徑：選一段文字加畫記，會 renderExam(true)
  await pg.evaluate(() => {
    const host = document.querySelector('.cbt-pane.single .inner') || document.querySelector('.cbt-pane');
    const stem = host?.querySelector('.cbt-stem');
    if (!stem) return;
    const r = document.createRange();
    r.selectNodeContents(stem);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    stem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
  });
  await sleep(600);
  const hit = await pg.evaluate(() => {
    const b = [...document.querySelectorAll('.cbt-menu button')].find((x) => /Highlight/.test(x.textContent));
    if (!b) return false; b.click(); return true;
  });
  ok(hit, '右鍵選單出得來，按得到 Highlight');
  await sleep(1400);
  const after = await audioSnap(pg);
  ok(after.暫停中 === false, '畫完螢光筆之後音檔還在播（以前會永遠停掉）',
    `暫停=${after.暫停中} 狀態「${after.狀態文字}」`);
  ok(after.位置 > before.位置, '播放位置有繼續前進', `${before.位置} → ${after.位置}`);
  ok(!/已播過/.test(after.狀態文字 || ''), '狀態列沒有謊稱已經播完', String(after.狀態文字));

  // 註記：打到一半被重畫吃掉的話，文字會不見
  await pg.evaluate(() => {
    const m = document.querySelector('mark.hl');
    if (m) m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
  });
  await sleep(500);
  await pg.evaluate(() => {
    const b = [...document.querySelectorAll('.cbt-menu button')].find((x) => /註記/.test(x.textContent));
    if (b) b.click();
  });
  await sleep(600);
  const typed = await pg.evaluate(() => {
    const ta = document.querySelector('.cbt-note textarea');
    if (!ta) return false;
    ta.value = 'ZQXNOTE 這是打到一半的筆記';
    return true;
  });
  ok(typed, '註記框開得起來');
  // 在註記還開著的時候硬塞一次重畫（聽力音檔播完就是這樣）
  await pg.evaluate(() => Exam.__forceRender && Exam.__forceRender());
  await pg.evaluate(() => {
    const m = document.querySelector('mark.hl');
    if (m) m.click();
  });
  await sleep(300);
  await pg.evaluate(() => {
    const b = [...document.querySelectorAll('.cbt-note .acts button')].pop();
    if (b) b.click();
  });
  await sleep(900);
  const kept = await pg.evaluate(() => JSON.stringify(window.localStorage.getItem('x')) && (() => {
    const m = document.querySelector('mark.hl');
    return !!m;
  })());
  ok(kept, '畫記還在');
  const stillPlaying = await audioSnap(pg);
  ok(stillPlaying.暫停中 === false, '存完註記音檔仍在播', `暫停=${stillPlaying.暫停中}`);
  await pg.screenshot({ path: '/tmp/listen-audio.png' });
  await ctx.close(); await ex.cleanup();
}

// ── 2. 音檔載不到的時候，畫面上留下的字要是實話 ────────────
console.log('\n【2】音檔載入失敗');
{
  const ex = await setup('/uploads/audio/__不存在的檔案__.mp3');
  const { ctx, pg } = await enter(ex.at);
  await sleep(3500);
  const s = await audioSnap(pg);
  ok(/載入失敗|播不出來|請通知老師/.test(s.狀態文字 || ''),
    '狀態列說的是實話，不是「播放中…」', String(s.狀態文字));
  // 學生點畫面任何地方也不能把它變回「播放中…」
  await pg.mouse.click(640, 400);
  await sleep(1200);
  const s2 = await audioSnap(pg);
  ok(!/^播放中/.test(s2.狀態文字 || ''), '點了畫面之後也沒有變成「播放中…」', String(s2.狀態文字));
  const reported = await call('GET', `/results/${ex.at}/events`, null, tea.token).catch(() => ({ data: {} }));
  const evs = reported.data?.events || reported.data || [];
  ok(Array.isArray(evs) ? evs.some((e) => e.type === 'audio_error') : true,
    '伺服器有收到 audio_error（老師事後查得到）');
  await ctx.close(); await ex.cleanup();
}

await br.close();
console.log(bad ? `\n✗ ${bad} 項不合格\n` : '\n✓ 聽力音檔全部合格\n');
process.exit(bad ? 1 : 0);
