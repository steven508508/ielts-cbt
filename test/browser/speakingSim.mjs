/* 口說考試的真瀏覽器模擬台。
 *
 * 為什麼需要：先前所有口說測試都是在 WebSocket 協定層跑的 ——
 * 從來沒有真的走過「學生點開始 → 按畫面上的按鈕」這條路。
 * 「按鈕完全沒反應」這種問題就躲在那個縫裡（對話框被重畫弄死，
 * await 永遠不回來），協定層的測試看不到。
 *
 * 這是共用的模擬台，由 speakingScenarios.mjs 呼叫。
 *   npm i -D playwright && npx playwright install chromium
 *   node test/browser/speakingScenarios.mjs
 */
import { chromium } from './_pw.mjs';
import { log, connections, mode, stop } from './fakeRealtime.mjs';
const B = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(m, p, b, t) {
  const h = {}; if (t) h.authorization = `Bearer ${t}`; if (b) h['content-type'] = 'application/json';
  const r = await fetch(B + '/api' + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
export const adm = (await call('POST', '/auth/login', { username: 'admin', password: 'admin1234' })).data.token;
export const tea = (await call('POST', '/auth/login', { username: 'teacher1', password: 'teach1234' })).data;
export { call, sleep, B, log, connections, mode, stop, chromium };

const before = (await call('GET', '/ai/settings', null, adm)).data;
export async function useFakeAi() {
  await call('PUT', '/ai/settings', { ai: { provider: 'custom', customProtocol: 'openai',
    customBaseUrl: 'http://127.0.0.1:4478/v1', customApiKey: 'k', customModel: 'fake-chat',
    ttsProvider: 'custom', sttProvider: 'custom', realtimeModel: 'fake-realtime', realtimeApi: 'ga' } }, adm);
  await sleep(300);
}
export async function restoreAi() {
  await call('PUT', '/ai/settings', { ai: before.ai, examiner: before.examiner }, adm);
}

/** 一份正常的口說試卷 */
export const SPEAKING_PAPER = (extra = {}) => ({
  title: `口說模擬 ${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
  testType: 'academic',
  modules: [{ module: 'speaking', durationSec: 900, sections: [{ title: 'Speaking', groups: [{
    type: 'speaking_part',
    questions: [
      { part: 1, topic: 'Your hometown',
        items: ['Where do you live?', 'Do you like living there?', 'What is it famous for?'] },
      { part: 2, cueCard: {
        topic: 'Describe a park you often visit',
        bullets: ['where it is', 'how often you go there', 'what you do there',
          'and explain why you like it'],
        prepSec: extra.prepSec ?? 4, talkSec: extra.talkSec ?? 6 },
        rounding: ['Do you go there with friends?', 'Is it busy at weekends?'] },
      { part: 3, topic: 'Cities and green space',
        items: ['Should cities have more parks?', 'How will cities change in the future?'] },
    ] }] }] }],
});

/** 開一場口說考試，回傳 attemptId */
export async function newExam(username, paperOverrides = {}) {
  const stu = (await call('POST', '/auth/login', { username, password: 'ielts1234' })).data;
  const t = await call('POST', '/tests', { paper: SPEAKING_PAPER(paperOverrides) }, tea.token);
  if (t.status !== 200) throw new Error('建卷失敗 ' + JSON.stringify(t.data));
  const asg = await call('POST', '/tests/assignments',
    { testId: t.data.id, userIds: [stu.user.id], modules: 'speaking', maxAttempts: 9 }, tea.token);
  const st = await call('POST', '/exam/start',
    { assignmentId: asg.data.ids[0], testId: t.data.id }, stu.token);
  return {
    stu, testId: t.data.id, asgId: asg.data.ids[0], at: st.data.attemptId,
    cleanup: async () => {
      await call('DELETE', `/tests/assignments/${asg.data.ids[0]}`, null, tea.token);
      await call('POST', '/manage/results/bulk', { action: 'delete', ids: [st.data.attemptId], force: true }, adm);
      await call('DELETE', `/tests/${t.data.id}`, null, adm);
    },
  };
}

/** 開瀏覽器並走到口說的即時對話畫面 */
export async function openSpeaking(ex, { viewport = { width: 1280, height: 800 } } = {}) {
  const br = await chromium.launch({ args: [
    '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ] });
  const ctx = await br.newContext({ viewport, permissions: ['microphone'] });
  await ctx.addInitScript(([tk, u]) => {
    localStorage.setItem('ielts_token', tk); localStorage.setItem('ielts_user', JSON.stringify(u));
  }, [ex.stu.token, ex.stu.user]);
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });

  await pg.goto(`${B}/#/exam/${ex.at}`); await sleep(1100); await pg.reload(); await sleep(2400);
  // 確認個人資料 → 科目清單 → 開始口說 → 口說說明頁 → 開始口說測驗
  const FWD = /^(資料正確|繼續|開始|進入|下一步|我已閱讀|同意|開始口說測驗)/;
  for (let i = 0; i < 12; i++) {
    if (await pg.$('#sp-orb')) break;
    let clicked = false;
    for (const b of await pg.$$('button')) {
      const tx = ((await b.textContent()) || '').trim();
      if (FWD.test(tx) && !/離開|測試麥克風|略過/.test(tx) && await b.isVisible() && await b.isEnabled()) {
        await b.click().catch(() => {}); clicked = true; break;
      }
    }
    await sleep(1600);
    if (!clicked) break;
  }
  return { br, ctx, pg, errors };
}

/** 畫面現在長什麼樣 */
export const snap = (pg) => pg.evaluate(() => ({
  stage: document.querySelector('#sp-stage')?.textContent?.trim() || null,
  qline: document.querySelector('#sp-q')?.textContent?.trim() || null,
  timer: document.querySelector('#sp-timer')?.offsetParent
    ? document.querySelector('#sp-timer')?.textContent?.trim() : null,
  cueVisible: !!document.querySelector('#sp-cue')?.offsetParent,
  cue: document.querySelector('#sp-cue')?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 90) || null,
  chat: [...document.querySelectorAll('#sp-chat > div')].map((d) => d.textContent.trim().slice(0, 60)),
  buttons: [...document.querySelectorAll('.cbt-btn, .cbt-tool')]
    .filter((b) => b.offsetParent).map((b) => ({ t: b.textContent.trim(), off: !!b.disabled })),
  toasts: [...document.querySelectorAll('.toast, .ui-toast, [class*=toast]')].map((t) => t.textContent.trim()),
  dialog: document.querySelector('dialog[open], .ui-modal, .modal')?.textContent?.trim().slice(0, 120) || null,
}));

/** 按下畫面上某顆按鈕（用文字找），回傳有沒有找到 */
export async function press(pg, re) {
  for (const b of await pg.$$('.cbt-btn, .cbt-tool, button')) {
    const tx = ((await b.textContent()) || '').trim();
    if (re.test(tx) && await b.isVisible()) {
      const disabled = await b.isDisabled();
      await b.click().catch(() => {});
      return { found: true, text: tx, disabled };
    }
  }
  return { found: false };
}

/** 讓假考官那一端模擬「學生講了一句話」 */
export const up = () => connections[connections.length - 1];
export async function say(text, { pause = 500 } = {}) {
  const u = up();
  if (!u) return false;
  u.speechStarted(); await sleep(120);
  u.speechStopped({ transcript: text });
  await sleep(pause);
  return true;
}
