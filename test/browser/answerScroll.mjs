/* 選了一個選項之後，畫面會不會跳回最上面。
 *
 * 這一類問題只有真的開瀏覽器、真的捲動、真的點下去才量得到 ——
 * API 測試全部都是綠的。原本的症狀是閱讀頁從 1392px 捲動位置掉回 0。
 *
 * Playwright 不是這個專案的相依套件，要跑的話先裝：
 *   npm i -D playwright && npx playwright install chromium
 *   node test/browser/answerScroll.mjs
 */
import pw from 'playwright';
const { chromium } = pw;
const B='http://localhost:3000';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function call(m,p,b,t){const h={};if(t)h.authorization='Bearer '+t;if(b)h['content-type']='application/json';
 const r=await fetch(B+'/api'+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined});
 return {status:r.status,data:await r.json().catch(()=>({}))};}
const adm=(await call('POST','/auth/login',{username:'admin',password:'admin1234'})).data.token;
const tea=(await call('POST','/auth/login',{username:'teacher1',password:'teach1234'})).data;
const stu=(await call('POST','/auth/login',{username:'student1',password:'ielts1234'})).data;

// 一份夠長、要捲動才看得到後面題目的試卷
const qs=(n,start,type)=>Array.from({length:n},(_,i)=>({number:start+i,
  text:`Question ${start+i}: this is a reasonably long statement so the page becomes tall enough to scroll.`,
  ...(type==='mcq_single'?{options:[{key:'A',text:'Option A text'},{key:'B',text:'Option B text'},
    {key:'C',text:'Option C text'},{key:'D',text:'Option D text'}],answers:['A']}:{answers:['TRUE']})}));
const paper={title:`捲動 ${Date.now()}`,testType:'academic',modules:[
 {module:'reading',durationSec:3600,sections:[{title:'Passage 1',
   passage:'<p>'+('Cities plant trees to cool streets. '.repeat(60))+'</p>',
   groups:[{type:'mcq_single',instructions:'Choose the correct letter.',questions:qs(10,1,'mcq_single')},
           {type:'tfng',instructions:'TRUE / FALSE / NOT GIVEN',questions:qs(10,11,'tfng')}]}]},
 {module:'listening',durationSec:1800,sections:[{title:'Section 1',audio:'/uploads/audio/demo.mp3',
   groups:[{type:'mcq_single',instructions:'Choose the correct letter.',questions:qs(12,1,'mcq_single')}]}]},
]};
const t=await call('POST','/tests',{paper},tea.token);
const asg=await call('POST','/tests/assignments',{testId:t.data.id,userIds:[stu.user.id],modules:'reading,listening',maxAttempts:9},tea.token);
const st=await call('POST','/exam/start',{assignmentId:asg.data.ids[0],testId:t.data.id},stu.token);
const at=st.data.attemptId;

const br=await chromium.launch({args:['--no-sandbox']});
async function probe(viewport,label,modName){
  const ctx=await br.newContext({viewport});
  await ctx.addInitScript(([tk,u])=>{localStorage.setItem('ielts_token',tk);localStorage.setItem('ielts_user',JSON.stringify(u));},[stu.token,stu.user]);
  const pg=await ctx.newPage();
  await pg.goto(`${B}/#/exam/${at}`); await sleep(1000); await pg.reload(); await sleep(2200);
  const FWD=/^(資料正確|繼續|開始|進入|下一步|我已閱讀|同意)/;
  for(let i=0;i<10;i++){ if(await pg.$('#q-1')) break;
    let c=false;
    for(const b of await pg.$$('button')){const tx=((await b.textContent())||'').trim();
      if(FWD.test(tx)&&!/離開/.test(tx)&&await b.isVisible()&&await b.isEnabled()){await b.click().catch(()=>{});c=true;break;}}
    await sleep(1600); if(!c) break; }
  if(!(await pg.$('#q-1'))){
    console.log(`  ${label}：進不去。畫面 =`,(await pg.evaluate(()=>document.body.innerText)).replace(/\n+/g,' | ').slice(0,260));
    console.log('    按鈕 =', (await pg.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.textContent.trim()))).join(' / ').slice(0,200));
    await ctx.close(); return; }

  // 捲到最下面的題目
  await pg.evaluate(()=>{ const q=document.querySelector('#q-8')||document.querySelector('#q-5');
    q?.scrollIntoView({block:'center'}); });
  await sleep(600);
  const snap=()=>pg.evaluate(()=>({
    win: window.scrollY,
    right: document.querySelector('.cbt-pane.right')?.scrollTop ?? null,
    single: document.querySelector('.cbt-pane.single')?.scrollTop ?? null,
    center: document.querySelector('.cbt-center')?.scrollTop ?? null,
    body: document.scrollingElement?.scrollTop ?? null,
    qTop: Math.round(document.querySelector('#q-8')?.getBoundingClientRect().top ?? 0),
  }));
  const before=await snap();
  // 點下去之後，連續量幾個時間點，看捲動位置是「一開始就沒設成功」還是「設了又被清掉」
  const trace=await pg.evaluate(async()=>{
    const g=()=>{const p=document.querySelector('.cbt-pane.right');
      return p?{top:p.scrollTop,h:p.scrollHeight,c:p.clientHeight}:null;};
    const out=[];
    document.querySelector('#q-8 label.cbt-opt')?.click();
    out.push(['同步 0ms',g()]);
    await new Promise(r=>requestAnimationFrame(r));
    out.push(['第一次繪製後',g()]);
    await new Promise(r=>requestAnimationFrame(r));
    out.push(['第二次繪製後',g()]);
    await new Promise(r=>setTimeout(r,300));
    out.push(['300ms 後',g()]);
    return out;
  });
  console.log('    點下去之後的軌跡：');
  trace.forEach(([k,v])=>console.log(`      ${k.padEnd(12)}`, JSON.stringify(v)));
  await sleep(500);
  const after=await snap();
  console.log(`\n  ${label}`);
  console.log('    點選項前 =', JSON.stringify(before));
  console.log('    點選項後 =', JSON.stringify(after));
  const moved=Math.abs((after.qTop||0)-(before.qTop||0));
  console.log(`    第 8 題在畫面上移動了 ${moved}px`, moved>80?'  ← 跳掉了':'  ✓ 沒跳');
  await ctx.close();
}
await probe({width:1280,height:800},'閱讀（桌機寬螢幕）','閱讀');
await probe({width:820,height:900},'閱讀（窄螢幕／平板）','閱讀');
await br.close();
await call('DELETE',`/tests/assignments/${asg.data.ids[0]}`,null,tea.token);
await call('POST','/manage/results/bulk',{action:'delete',ids:[at],force:true},adm);
await call('DELETE',`/tests/${t.data.id}`,null,adm);
