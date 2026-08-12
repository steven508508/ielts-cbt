/* 示範站的說明橫幅。
 *
 * 放在 .cbt 之外會失去全部樣式（整份 CSS 變數都掛在 .cbt 上），所以這裡
 * 自帶樣式，不依賴任何既有的 class。
 */
(function () {
  'use strict';
  const KEY = 'ielts_demo_banner_dismissed';
  let dismissed = false;
  try { dismissed = localStorage.getItem(KEY) === '1'; } catch {}

  const css = document.createElement('style');
  css.textContent = `
  #demo-bar{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#0f172a;color:#e2e8f0;
    font:14px/1.5 system-ui,-apple-system,"Noto Sans TC",sans-serif;padding:10px 14px;
    display:flex;gap:12px;align-items:center;box-shadow:0 -2px 12px rgba(0,0,0,.25)}
  #demo-bar b{color:#fff}
  #demo-bar .grow{flex:1;min-width:0}
  #demo-bar a{color:#7dd3fc}
  #demo-bar button{background:#334155;color:#e2e8f0;border:0;border-radius:6px;
    padding:6px 12px;cursor:pointer;font:inherit;white-space:nowrap}
  #demo-bar button:hover{background:#475569}
  #demo-bar button.x{background:transparent;padding:6px 8px;font-size:18px;line-height:1}
  #demo-more{position:fixed;inset:0;z-index:10000;background:rgba(2,6,23,.72);
    display:flex;align-items:center;justify-content:center;padding:20px}
  #demo-more .card{background:#fff;color:#0f172a;max-width:560px;width:100%;
    border-radius:12px;padding:22px 24px;font:15px/1.7 system-ui,-apple-system,"Noto Sans TC",sans-serif;
    max-height:80vh;overflow:auto}
  #demo-more h2{margin:0 0 12px;font-size:19px}
  #demo-more ul{margin:8px 0 16px;padding-left:20px}
  #demo-more li{margin:6px 0}
  #demo-more .foot{display:flex;gap:10px;justify-content:flex-end;margin-top:8px}
  #demo-more button{border:0;border-radius:6px;padding:8px 16px;cursor:pointer;font:inherit}
  #demo-more .primary{background:#0f172a;color:#fff}
  @media(max-width:640px){#demo-bar{flex-wrap:wrap;font-size:13px}}
  /* 考試畫面是 position:fixed; inset:0，會鋪滿整個視窗 —— 橫幅直接蓋在
     底部題號列上面，而題號列正好是這個系統最該被看到的東西之一。
     所以不是把橫幅疊上去，是把考試畫面的下緣往上收。 */
  body.demo-bar-on .cbt{bottom:var(--demo-bar-h,46px) !important}
  `;
  document.head.appendChild(css);

  function detail() {
    const wrap = document.createElement('div');
    wrap.id = 'demo-more';
    wrap.innerHTML = `
      <div class="card">
        <h2>這個示範站是怎麼運作的</h2>
        <p>你現在操作的畫面，是這個專案<b>真正的前端程式碼</b>，一行都沒有改。
           分割視窗、螢光筆、便利貼、播一次就不能倒帶的音檔、底部題號列、
           高對比與大字模式、圖表縮放 —— 全部都是真的。</p>
        <p>不一樣的地方只有後端：GitHub Pages 只能放靜態檔案，所以資料與批改
           改成在你自己的瀏覽器裡跑。</p>
        <ul>
          <li><b>聽力與閱讀的批改是真的</b> —— 直接使用 <code>server/lib/answers.js</code>
              與 <code>server/lib/bands.js</code>，跟正式站同一份程式碼，
              所以分數換算也一樣。</li>
          <li><b>寫作評分是預先寫好的</b>，不會隨你寫的內容改變。正式站是每一篇送給 AI 批改。</li>
          <li><b>口說是錄好的示範對話</b>。考官會真的出聲、逐字稿會即時出現、
              評分會一段一段浮現，但那是照腳本重播的 —— 不會要求麥克風權限，
              你的聲音不會被送到任何地方。正式站是跟 AI 考官全雙工即時對話。</li>
          <li><b>沒有伺服器就沒有資料</b>。重新整理就是全新的一份，不需要每天重置。</li>
        </ul>
        <p>想看完整的東西（老師端、班級管理、真的 AI 批改與即時口說），
           就是 <code>docker compose up</code> 一行的事。</p>
        <div class="foot">
          <button class="primary" id="demo-close">知道了</button>
        </div>
      </div>`;
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.id === 'demo-close') wrap.remove();
    });
    document.body.appendChild(wrap);
  }

  function bar() {
    const b = document.createElement('div');
    b.id = 'demo-bar';
    b.innerHTML = `
      <span class="grow"><b>示範站</b> —— 真的前端，假的後端。重整就會回到全新狀態。
        口說是錄好的示範，不會用到你的麥克風。</span>
      <button id="demo-how">這是什麼？</button>
      <a href="https://github.com/steven508508/ielts-cbt"><button>原始碼</button></a>
      <button class="x" id="demo-x" title="關閉">×</button>`;
    b.querySelector('#demo-how').onclick = detail;
    b.querySelector('#demo-x').onclick = () => {
      b.remove();
      document.body.classList.remove('demo-bar-on');
      try { localStorage.setItem(KEY, '1'); } catch {}
    };
    document.body.appendChild(b);
    document.body.classList.add('demo-bar-on');

    // 橫幅在窄畫面會換行變高，高度得跟著量
    const measure = () => document.documentElement.style
      .setProperty('--demo-bar-h', b.offsetHeight + 'px');
    measure();
    addEventListener('resize', measure);
    if (window.ResizeObserver) new ResizeObserver(measure).observe(b);
  }

  const go = () => { if (!dismissed) bar(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();
