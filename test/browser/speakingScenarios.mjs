/* 口說考試的三種學生情境。
 *
 *   ① 對話框在底層重畫之後還活著（否則按鈕會整個卡死）
 *   ② 考到一半重新整理，對話接得回來
 *   ③ 走完全程，每個階段的題目都送到考官
 *
 * 需要 Playwright：
 *   npm i -D playwright && npx playwright install chromium
 *   node test/browser/speakingScenarios.mjs
 */
/* 驗證：對話框不再被重畫弄死 + 重整後對話補得回來 + 各階段指示 */
import { useFakeAi, restoreAi, newExam, openSpeaking, snap, press, say, sleep, call, tea, log, stop } from './speakingSim.mjs';
await useFakeAi();
const line=t=>console.log('   '+t);

console.log('━━━ ① 對話框存活測試（按鈕會不會卡死）━━━');
{
  const ex = await newExam('student1');
  const { br, pg, errors } = await openSpeaking(ex);
  await sleep(1500);
  // 開一個對話框，然後在它開著的時候讓畫面重畫
  await press(pg, /^❓ Help$/); await sleep(800);
  const vis=()=>{const d=document.querySelector('.cbt-dim');
    if(!d) return {gone:true};
    const r=d.getBoundingClientRect();
    return {gone:false, connected:d.isConnected, w:Math.round(r.width), h:Math.round(r.height),
      parent:d.parentElement?.tagName, display:getComputedStyle(d).display};};
  const dlgOpen = await pg.evaluate(()=>{
    const d=document.querySelector('.cbt-dim'); const r=d?.getBoundingClientRect();
    return { inBody: d?.parentElement?.tagName, visible: !!d && r.width>100 && r.height>100,
      text: document.querySelector('.cbt-dialog')?.textContent?.slice(0,40) };});
  line(`Help 對話框：掛在 body=${dlgOpen.inBody} 看得到=${dlgOpen.visible}「${dlgOpen.text}」`);
  // 強制重畫底層畫面
  await pg.evaluate(()=>{ const a=document.getElementById('app'); const d=document.createElement('div');
    d.className='cbt'; d.textContent='（重畫過的畫面）'; a.replaceChildren(d); });
  await sleep(500);
  const after = await pg.evaluate(()=>{const d=document.querySelector('.cbt-dim');
    const r=d?.getBoundingClientRect(); return !!d && d.isConnected && r.width>100;});
  line(`底層重畫之後對話框還在 = ${after ? '✓ 還在（await 回得來）' : '✗ 被拔掉了'}`);
  await press(pg, /^OK$/); await sleep(600);
  line(`按 OK 之後關掉 = ${!(await pg.evaluate(()=>!!document.querySelector('.cbt-dim')))}`);
  if (errors.length) line(`錯誤：${errors.slice(0,2).join(' ｜ ')}`);
  await br.close(); await ex.cleanup();
}

console.log('\n━━━ ② 重整之後對話補得回來嗎 ━━━');
{
  const ex = await newExam('student1');
  const { br, pg } = await openSpeaking(ex);
  await sleep(1500);
  await say('My name is Wang Xiaoming.');
  await say('I am from Taipei.');
  await sleep(1000);
  const b4 = await snap(pg);
  line(`重整前：階段「${b4.stage}」，對話 ${b4.chat.length} 則`);
  await pg.reload(); await sleep(3000);
  for(let i=0;i<6;i++){ if(await pg.$('#sp-orb')) break;
    let c=false; for(const b of await pg.$$('button')){const tx=((await b.textContent())||'').trim();
      if(/^(繼續作答|繼續|開始|開始口說測驗)/.test(tx)&&!/離開/.test(tx)&&await b.isVisible()){await b.click().catch(()=>{});c=true;break;}}
    await sleep(1700); if(!c) break; }
  await sleep(1500);
  const af = await snap(pg);
  line(`重整後：階段「${af.stage}」，對話 ${af.chat.length} 則 ${af.chat.length>0?'✓ 補回來了':'✗ 全部不見'}`);
  af.chat.slice(0,3).forEach(c=>line('  '+c));
  await br.close(); await ex.cleanup();
}

console.log('\n━━━ ③ 走完全程，每個階段的題目都要送到考官 ━━━');
{
  const ex = await newExam('student1', { prepSec: 3, talkSec: 3 });
  log.length = 0;
  const { br, pg } = await openSpeaking(ex);
  await sleep(1500);
  await say('My name is Wang.'); await say('I am from Taipei.'); await sleep(700);
  await press(pg, /進入下一部分/); await sleep(2000);   // → Part 2 讀題
  await sleep(4500);                                    // 準備 3 秒
  await say('The park is Daan Forest Park.');
  await sleep(17000);                                   // 長回答 3 秒 + 12 秒寬限 → 收尾
  await say('Yes, with my family.'); await sleep(700);
  await say('It is busy at weekends.'); await sleep(1500);
  const s = await snap(pg);
  line(`目前階段「${s.stage}」`);
  const stages=[...new Set(log.filter(x=>x.t==='session.update').map(x=>x.stage))];
  line(`考官收到的階段：${stages.join(' → ')}`);
  const all = log.filter(x=>x.t==='session.update').map(x=>x.instructions).join('\n');
  for (const [n,txt] of [['Part 1 題目','What is it famous for?'],
    ['Part 2 提示卡','Describe a park you often visit'],
    ['Part 2 收尾問題','Do you go there with friends?'],
    ['Part 3 題目','Should cities have more parks?']]) {
    line(`${n.padEnd(16)} ${all.includes(txt)?'✓ 有送到':'✗ 沒送到'}`);
  }
  await br.close(); await ex.cleanup();
}
await restoreAi(); stop(); process.exit(0);
