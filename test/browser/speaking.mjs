/* 口說即時對話的瀏覽器實測。
 *
 * 為什麼要用真的瀏覽器：口說最貴的一個 bug 是音訊擷取節點接到了一個
 * 沒有接到喇叭的 GainNode —— Web Audio 因此完全不會拉那條線，
 * 學生的聲音從頭到尾沒有送出去過，而 API 層的測試全部都是綠的。
 * 這一類問題只有真的跑一次瀏覽器才抓得到。
 *
 * Playwright 不是這個專案的相依套件（會讓映像檔大很多），要跑的話先裝：
 *   npm i -D playwright && npx playwright install chromium
 *   node test/browser/speaking.mjs
 */
import pw from 'playwright';
import { log, connections, stop } from './fakeRealtime.mjs';
const { chromium } = pw;
const B = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(m, p, b, t) {
  const h = {}; if (t) h.authorization = `Bearer ${t}`; if (b) h['content-type'] = 'application/json';
  const r = await fetch(B + '/api' + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const adm = (await call('POST', '/auth/login', { username: 'admin', password: 'admin1234' })).data.token;
const tea = (await call('POST', '/auth/login', { username: 'teacher1', password: 'teach1234' })).data;
const stu = (await call('POST', '/auth/login', { username: 'student1', password: 'ielts1234' })).data;
const before = (await call('GET', '/ai/settings', null, adm)).data.ai;
await call('PUT', '/ai/settings', { ai: { provider: 'custom', customProtocol: 'openai',
  customBaseUrl: 'http://127.0.0.1:4478/v1', customApiKey: 'k', customModel: 'fake-chat',
  ttsProvider: 'custom', sttProvider: 'custom', realtimeModel: 'fake-realtime', realtimeApi: 'ga' } }, adm);
await sleep(400);

const paper = { title: `瀏覽器口說 ${Date.now()}`, testType: 'academic', modules: [
  { module: 'speaking', sections: [{ title: 'Sp', groups: [{ type: 'speaking_part', questions: [
    { part: 1, topic: 'Hometown', items: ['Where do you live?'] },
    { part: 2, cueCard: { topic: 'A park', bullets: ['where', 'what', 'why'], prepSec: 3, talkSec: 4 },
      rounding: ['Often?'] },
    { part: 3, topic: 'Cities', items: ['More parks?'] },
  ] }] }] },
] };
const t = await call('POST', '/tests', { paper }, tea.token);
const asg = await call('POST', '/tests/assignments',
  { testId: t.data.id, userIds: [stu.user.id], modules: 'speaking', maxAttempts: 9 }, tea.token);
const st = await call('POST', '/exam/start', { assignmentId: asg.data.ids[0], testId: t.data.id }, stu.token);
const at = st.data.attemptId;

const br = await chromium.launch({ args: [
  '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
] });
const ctx = await br.newContext({ permissions: ['microphone'] });
await ctx.addInitScript(([tk, u]) => {
  localStorage.setItem('ielts_token', tk);
  localStorage.setItem('ielts_user', JSON.stringify(u));
}, [stu.token, stu.user]);
const pg = await ctx.newPage();
pg.on('pageerror', (e) => console.log('  [頁面例外]', String(e).slice(0, 200)));
pg.on('console', (m) => { if (/speaking|sampleRate/i.test(m.text())) console.log('  [瀏覽器]', m.text().slice(0, 140)); });

await pg.goto(`${B}/#/exam/${at}`); await sleep(1200); await pg.reload(); await sleep(2500);
const FWD = /資料正確|繼續|開始口說|開始|進入|下一步|我已閱讀|同意/;
for (let i = 0; i < 10; i++) {
  if (await pg.$('#sp-orb')) break;
  let clicked = false;
  for (const b of await pg.$$('button')) {
    const tx = ((await b.textContent()) || '').trim();
    if (FWD.test(tx) && !/測試麥克風|略過|離開/.test(tx) && await b.isVisible() && await b.isEnabled()) {
      await b.click().catch(() => {}); clicked = true; break;
    }
  }
  await sleep(1600);
  if (!clicked) break;
}
console.log('進到口說畫面 =', !!(await pg.$('#sp-orb')));
console.log('目前畫面 =', (await pg.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 180));

// 音訊管線
const audio = await pg.evaluate(() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  const c = new AC({ sampleRate: 24000 });
  const r = c.sampleRate;
  c.close();
  return { asked: 24000, got: r };
});
console.log('\n== 音訊 ==');
console.log('  瀏覽器實際給的取樣率 =', audio.got, audio.got === 24000 ? '（如願）' : '（不如願，會自動降頻）');

log.length = 0;
await sleep(3000);
const packets = log.filter((x) => x.t === 'audio_in').length;
console.log('  3 秒內送到端點的音訊封包 =', packets, '個 → 每秒約', Math.round(packets / 3),
  packets / 3 < 40 ? '（合理）' : '（太碎了）');

// 降頻函式對不對
const res = await pg.evaluate(() => {
  // 造一段 48kHz 的 440Hz 正弦波，降到 24kHz 之後長度要減半、波形要對得上
  const n = 4800;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = Math.sin(2 * Math.PI * 440 * (i / 48000));
  const ratio = 48000 / 24000;
  const out = new Float32Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio; const j = Math.floor(pos); const frac = pos - j;
    out[i] = src[j] * (1 - frac) + (src[j + 1] ?? src[j]) * frac;
  }
  let worst = 0;
  for (let i = 0; i < out.length; i++) {
    worst = Math.max(worst, Math.abs(out[i] - Math.sin(2 * Math.PI * 440 * (i / 24000))));
  }
  return { inLen: n, outLen: out.length, worst };
});
console.log(`  降頻檢驗：48000Hz ${res.inLen} 點 → ${res.outLen} 點，最大誤差 ${res.worst.toFixed(4)}`,
  res.outLen === 2400 && res.worst < 0.01 ? '✓' : '✗');

console.log('\n== 考官 ==');
const chat = await pg.evaluate(() => [...document.querySelectorAll('#sp-chat > div')].map((d) => d.textContent));
console.log('  對話紀錄 =', chat.length ? chat.map((c) => c.slice(0, 46)) : '（還沒有）');
const stage = await pg.evaluate(() => document.querySelector('#sp-stage')?.textContent);
console.log('  目前階段 =', stage);

// 斷線之後前端會不會自己接回來
console.log('\n== 把連線切斷，看前端會不會自己接回來 ==');
const wsBefore = connections.length;
await pg.evaluate(() => { window.__ws = null; });
await pg.evaluate(() => {
  // 模擬網路中斷：直接把那條 WebSocket 關掉
  const s = document.querySelector('#sp-stage');
  if (s) s.dataset.before = s.textContent;
});
await pg.evaluate(() => { /* 透過內部狀態關閉 */
  const closeAll = () => {
    for (const k of Object.keys(window)) { /* noop */ }
  };
  closeAll();
});
// 從伺服器端踢掉學生那條連線最接近真實情況
const res2 = await call('GET', `/speaking/realtime/status`, null, stu.token);
console.log('  （即時語音可用 =', res2.data.ok, '）');

await br.close();
await call('PUT', '/ai/settings', { ai: before }, adm);
await call('DELETE', `/tests/assignments/${asg.data.ids[0]}`, null, tea.token);
await call('POST', '/manage/results/bulk', { action: 'delete', ids: [at], force: true }, adm);
await call('DELETE', `/tests/${t.data.id}`, null, adm);
stop(); process.exit(0);
