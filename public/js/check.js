/* 考前環境診斷。
 *
 * 這一頁刻意做成「不用登入就能開」——學生考前一天在家自己測，
 * 測出問題還有時間處理。真正的重點是麥克風：
 * 權限要在這裡拿到，而不是等到考試中、人已經在全螢幕監考裡面才問。
 * 那時候學生為了去瀏覽器設定開權限而退出全螢幕，會被記成違規。
 */
window.Check = (() => {
  const { el, $ } = UI;

  const VERSION = 1;                       // 檢查項目改版時 +1，舊的通過紀錄就失效
  const PASS_KEY = 'ielts_devicecheck';
  const PASS_TTL_DAYS = 7;

  const S = {};

  // ── 通過紀錄（存在這台電腦上）────────────────────────────
  function readPass() {
    try {
      const v = JSON.parse(localStorage.getItem(PASS_KEY) || 'null');
      if (!v || v.version !== VERSION) return null;
      if (Date.now() - v.at > PASS_TTL_DAYS * 86400000) return null;
      return v;
    } catch { return null; }
  }
  function writePass(info) {
    try { localStorage.setItem(PASS_KEY, JSON.stringify({ ...info, version: VERSION, at: Date.now() })); }
    catch { /* 無痕模式寫不進去，那就每次都重測 */ }
  }
  /** 這台電腦最近有沒有通過（給考試流程擋門用）*/
  function recentlyPassed() {
    const p = readPass();
    return !!(p && p.micOk);
  }

  // ── 單項檢查 ──────────────────────────────────────────────
  const R = (status, note = '', kind = '') => ({ status, note, kind });

  function checkBrowser() {
    const ua = navigator.userAgent;
    const m = ua.match(/(Edg|OPR|Chrome|Firefox|Version)\/(\d+)/g) || [];
    const name = /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari' : '未知瀏覽器';
    const ver = Number((ua.match(/(?:Edg|OPR|Chrome|Firefox|Version)\/(\d+)/) || [])[1] || 0);
    const min = { Chrome: 100, Edge: 100, Firefox: 100, Opera: 90, Safari: 15 }[name] || 0;
    S.browser = `${name} ${ver || '?'}`;
    if (name === '未知瀏覽器') return R('warn', `認不出來的瀏覽器（${ua.slice(0, 40)}…）`);
    if (min && ver && ver < min) return R('warn', `${name} ${ver} 太舊，建議更新到 ${min} 以上`);
    return R('pass', `${name} ${ver}`);
  }

  function checkSecure() {
    if (window.isSecureContext) return R('pass', location.protocol === 'https:' ? 'HTTPS' : 'localhost');
    return R('fail', '不是 https:// 也不是 localhost，瀏覽器不會給麥克風權限');
  }

  async function checkServer() {
    const t0 = performance.now();
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const ms = Math.round(performance.now() - t0);
      const d = await r.json();
      S.serverTime = d.time;
      S.serverVersion = d.version;
      if (!d.ok) return R('fail', '伺服器有回應，但資料庫連不上');
      if (ms > 1500) return R('warn', `連得上但很慢（${ms} ms）`);
      return R('pass', `${ms} ms`);
    } catch (e) {
      return R('fail', `連不到考試伺服器：${e.message}`);
    }
  }

  function checkClock() {
    if (!S.serverTime) return R('skip');
    const diff = Math.abs(Date.now() - S.serverTime);
    if (diff > 5 * 60000) return R('warn', `和伺服器差 ${Math.round(diff / 60000)} 分鐘，考試時間可能顯示不準`);
    return R('pass', `誤差 ${Math.round(diff / 1000)} 秒內`);
  }

  function checkScreen() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    S.screen = `${w}×${h}`;
    if (w < 900) return R('warn', `視窗只有 ${w}px 寬，閱讀分割畫面會很擠（建議 1280 以上）`);
    if (h < 600) return R('warn', `視窗只有 ${h}px 高，建議放大瀏覽器視窗`);
    return R('pass', `${w}×${h}`);
  }

  function checkStorage() {
    try {
      localStorage.setItem('__t', '1');
      localStorage.removeItem('__t');
      return R('pass', '正常');
    } catch {
      return R('fail', '瀏覽器擋掉了本機儲存（無痕模式或隱私設定），登入狀態會存不住');
    }
  }

  function checkFullscreen() {
    const e = document.documentElement;
    if (!(e.requestFullscreen || e.webkitRequestFullscreen)) {
      return R('warn', '這個瀏覽器不支援全螢幕，監考模式的考試可能無法進行');
    }
    return R('pass', '支援');
  }

  function checkAudioFormat() {
    const a = document.createElement('audio');
    const mp3 = a.canPlayType('audio/mpeg');
    const webm = a.canPlayType('audio/webm; codecs=opus');
    if (!mp3 && !webm) return R('fail', '這個瀏覽器播不了聽力音檔');
    if (!mp3) return R('warn', '播不了 MP3，部分聽力音檔可能沒聲音');
    return R('pass', 'MP3 可播放');
  }

  async function checkWs() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      try {
        const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/speaking`;
        const ws = new WebSocket(url);
        const timer = setTimeout(() => { try { ws.close(); } catch {} finish(R('warn', '連線逾時，口說即時對話可能無法使用')); }, 6000);
        ws.onopen = () => { clearTimeout(timer); try { ws.close(); } catch {} finish(R('pass', '通道正常')); };
        ws.onerror = () => { clearTimeout(timer); finish(R('warn', '連不上，口說會自動退回問答模式（仍可考）')); };
      } catch (e) { finish(R('warn', e.message)); }
    });
  }

  async function checkTurnstile() {
    if (!S.turnstileEnabled) return R('skip');
    try {
      // 只要載得到腳本就代表網路通得到 Cloudflare；載不到的話全校都會登不進來
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        s.onload = res;
        s.onerror = () => rej(new Error('載入失敗'));
        setTimeout(() => rej(new Error('逾時')), 8000);
        document.head.append(s);
      });
      return R('pass', '連得到 Cloudflare');
    } catch (e) {
      return R('fail', `連不到 challenges.cloudflare.com（${e.message}），這台電腦會登不進系統`);
    }
  }

  /** 這個瀏覽器的麥克風設定藏在哪裡 */
  function micSettingsPath() {
    const b = String(S.browser || '');
    if (/Edge/.test(b)) return { url: 'edge://settings/content/microphone', how: '網址列貼上 edge://settings/content/microphone' };
    if (/Firefox/.test(b)) return { url: 'about:preferences#privacy', how: '網址列貼上 about:preferences#privacy，往下找「權限 → 麥克風 → 設定」' };
    if (/Safari/.test(b)) return { url: '', how: '上方選單「Safari → 設定 → 網站 → 麥克風」，把這個網站改成「允許」' };
    if (/Opera/.test(b)) return { url: 'opera://settings/content/microphone', how: '網址列貼上 opera://settings/content/microphone' };
    return { url: 'chrome://settings/content/microphone', how: '網址列貼上 chrome://settings/content/microphone' };
  }

  /**
   * 這個「頁面」本身有沒有被 Permissions-Policy 標頭擋掉麥克風。
   *
   * 這一項跟使用者的瀏覽器設定完全無關 —— 標頭擋掉的話，
   * 網站設定裡按幾次「允許」都沒有用，getUserMedia 一樣丟 NotAllowedError，
   * 而且 permissions.query 會回報 denied，看起來就像「使用者自己封鎖的」。
   * Safari 沒有實作這個標頭的麥克風限制，所以會出現「Chrome 不行、Safari 可以」。
   */
  function micBlockedByPolicy() {
    try {
      const fp = document.permissionsPolicy || document.featurePolicy;
      if (fp && typeof fp.allowsFeature === 'function') return !fp.allowsFeature('microphone');
    } catch { /* Safari 沒有這個 API */ }
    return false;
  }

  /** 把這一頁實際收到的標頭讀回來，好直接指給管理員看是哪一段擋的 */
  async function permissionsPolicyHeader() {
    try {
      const r = await fetch(location.pathname || '/', { method: 'HEAD', cache: 'no-store' });
      // 同名標頭會被瀏覽器用 ", " 併成一條，重複加的那一份也看得到
      return r.headers.get('permissions-policy') || r.headers.get('feature-policy') || '';
    } catch { return ''; }
  }

  /** 瀏覽器有沒有記住「已封鎖」——記住的話點不點網址列圖示都沒用，要去設定裡解 */
  async function micPermissionState() {
    try {
      const st = await navigator.permissions.query({ name: 'microphone' });
      return st.state;                    // granted | denied | prompt
    } catch { return 'unknown'; }         // Firefox 舊版與 Safari 查不到
  }

  /**
   * 麥克風：不只要權限，還要真的收得到聲音。
   * 失敗時給的必須是「照著做就能解決」的步驟，不是一句「權限被拒絕」。
   */
  async function checkMic(onLevel) {
    if (!navigator.mediaDevices?.getUserMedia) {
      return R('fail', '這個瀏覽器不支援錄音，請改用 Chrome 或 Edge');
    }

    // 最常見的坑：用 http:// 加 IP 直連。這種情況瀏覽器連問都不會問，
    // 直接丟 NotAllowedError —— 這時候叫學生去點網址列的鎖頭是白費工，
    // 那裡根本沒有「麥克風」這個選項。
    if (!window.isSecureContext) {
      return R('fail', `這個網址（${location.origin}）不是安全連線，瀏覽器不會給麥克風權限。`
        + '這不是瀏覽器設定的問題，要請老師或管理員替考試網站加上 HTTPS。', 'insecure');
    }

    // 標頭擋掉的話，連問都不用問 —— 而且錯誤長得跟「使用者封鎖」一模一樣，
    // 不先分辨出來，學生會被指去改一個改了也沒用的設定。
    if (micBlockedByPolicy()) {
      S.ppHeader = await permissionsPolicyHeader();
      return R('fail', '這個網站的伺服器用 Permissions-Policy 標頭把麥克風關掉了。'
        + '這跟你的瀏覽器設定無關 —— 在網站設定裡按幾次「允許」都不會有用，要改伺服器。', 'policyHeader');
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = e.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        const state = await micPermissionState();
        return R('fail', state === 'denied'
          ? `這個網站（${location.origin}）被瀏覽器記成「封鎖麥克風」了。點網址列左邊的圖示改成允許，或到瀏覽器設定裡把它移出封鎖清單。`
          : '剛剛的權限詢問被關掉或按了封鎖。按下面的「再測一次麥克風」，這次請選「允許」。',
        state === 'denied' ? 'blocked' : 'dismissed');
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        return R('fail', '找不到麥克風。請把耳機或麥克風插上去，或到系統的音效設定確認有輸入裝置，再測一次');
      }
      if (name === 'NotReadableError') {
        return R('fail', '麥克風被其他程式占用（視訊軟體、錄音程式、線上會議），請先關掉它們再測一次');
      }
      if (name === 'NotSupportedError') {
        return R('fail', '這台電腦的系統或瀏覽器政策不允許錄音（常見於學校／公司統一管理的電腦）。'
          + '請換一台電腦，或請資訊組協助開放', 'policy');
      }
      // 認不出來的錯誤也要給學生一條路走，不要只丟一行英文
      return R('fail', `無法使用麥克風。建議改用 Chrome 或 Edge 再試一次；還是不行的話，把這段訊息給老師：${name || 'Error'} / ${e.message}`);
    }

    // 有權限了，接著量 3 秒看看真的有沒有聲音進來
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      let peak = 0;
      const t0 = Date.now();
      await new Promise((res) => {
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let max = 0;
          for (const v of buf) max = Math.max(max, Math.abs(v - 128));
          const level = Math.min(1, max / 90);
          peak = Math.max(peak, level);
          onLevel?.(level, peak);
          if (Date.now() - t0 > 3200) return res();
          requestAnimationFrame(tick);
        };
        tick();
      });
      ctx.close().catch(() => {});
      stream.getTracks().forEach((t) => t.stop());

      const dev = (await navigator.mediaDevices.enumerateDevices().catch(() => []))
        .find((d) => d.kind === 'audioinput' && d.label);
      S.micLabel = dev?.label || '';
      if (peak < 0.06) {
        return R('warn', `有權限，但幾乎沒收到聲音${S.micLabel ? `（${S.micLabel}）` : ''}。請確認選到正確的麥克風，並對著它說話再測一次`);
      }
      return R('pass', `收音正常${S.micLabel ? `（${S.micLabel}）` : ''}`);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      return R('warn', `拿到權限但測不了音量：${e.message}`);
    }
  }

  /** 喇叭：放一段 440Hz，由學生自己回答有沒有聽到 */
  function playTone(sec = 1.5) {
    return new Promise((res, rej) => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + sec);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + sec);
        osc.onended = () => { ctx.close().catch(() => {}); res(); };
      } catch (e) { rej(e); }
    });
  }

  // ── 畫面 ──────────────────────────────────────────────────
  const ICON = { pass: '✓', warn: '!', fail: '✕', skip: '–', running: '⋯', pending: '' };

  function row(id, label, critical) {
    const icon = el('span', { class: 'chk-icon pending' }, '');
    const note = el('div', { class: 'chk-note' }, '尚未檢查');
    const extra = el('div', { class: 'chk-extra' });
    const box = el('div', { class: 'chk-row', id: `chk-${id}` },
      icon,
      el('div', { class: 'chk-main' },
        el('div', { class: 'chk-label' }, label,
          critical ? el('span', { class: 'chk-must' }, '必要') : null),
        note, extra));
    return {
      box,
      extra,
      set(status, text) {
        icon.className = `chk-icon ${status}`;
        icon.textContent = ICON[status] ?? '';
        note.textContent = text || '';
        note.className = `chk-note ${status}`;
        box.className = `chk-row ${status}`;
      },
    };
  }

  async function render(mount, { onDone = null, gate = false } = {}) {
    let cfg = { checks: {}, turnstileEnabled: false };
    try { cfg = await API.get('/check/config'); } catch { /* 離線也要能開 */ }
    S.turnstileEnabled = cfg.turnstileEnabled;

    const order = ['browser', 'secure', 'server', 'clock', 'screen', 'storage',
      'fullscreen', 'audio', 'speaker', 'mic', 'ws', 'turnstile'];
    const rows = {};
    const listBox = el('div', { class: 'chk-list' });
    for (const id of order) {
      const meta = cfg.checks[id] || { label: id, critical: false };
      rows[id] = row(id, meta.label, meta.critical);
      listBox.append(rows[id].box);
    }

    const bar = el('div', { class: 'chk-bar' }, el('i'));
    const verdict = el('div', { class: 'chk-verdict' });
    const runBtn = el('button', { class: 'btn primary lg' }, '開始檢查');
    const actions = el('div', { class: 'toolbar' }, runBtn);

    UI.render(mount,
      el('div', { class: 'chk-wrap' },
        el('h2', {}, '考前環境檢查'),
        el('p', { class: 'muted' },
          '不用登入，大約一分鐘。建議',
          el('b', {}, '用你考試那天要用的那台電腦、那個瀏覽器'),
          '跑一次 —— 尤其是麥克風權限，先在這裡開好，考試中就不會因為去改設定而被記成違規。'),
        el('div', { class: 'card' }, bar, listBox, verdict, actions)));

    let results = {};
    let running = false;

    async function step(id, fn) {
      rows[id].set('running', '檢查中…');
      let r;
      try { r = await fn(); } catch (e) { r = R('fail', e.message); }
      results[id] = r;
      rows[id].set(r.status, r.status === 'skip' ? (r.note || '這個系統沒有啟用，不用檢查') : (r.note || ''));
      const done = Object.keys(results).length;
      bar.firstChild.style.width = `${Math.round((done / order.length) * 100)}%`;
      return r;
    }

    async function runAll() {
      if (running) return;
      running = true;
      results = {};
      verdict.textContent = '';
      verdict.className = 'chk-verdict';
      runBtn.disabled = true;
      runBtn.textContent = '檢查中…';

      await step('browser', checkBrowser);
      await step('secure', checkSecure);
      await step('server', checkServer);
      await step('clock', checkClock);
      await step('screen', checkScreen);
      await step('storage', checkStorage);
      await step('fullscreen', checkFullscreen);
      await step('audio', checkAudioFormat);

      // 喇叭要學生自己回答，所以獨立處理
      await step('speaker', async () => {
        rows.speaker.set('running', '請按下方按鈕，聽聽看有沒有「嗶」一聲');
        const heard = await new Promise((res) => {
          const yes = el('button', { class: 'btn sm primary', onclick: () => res(true) }, '有聽到');
          const no = el('button', { class: 'btn sm', onclick: () => res(false) }, '沒聽到');
          const play = el('button', {
            class: 'btn sm',
            onclick: async (e) => {
              e.target.disabled = true;
              await playTone().catch(() => {});
              setTimeout(() => { e.target.disabled = false; }, 300);
            },
          }, '🔊 播放測試音');
          UI.render(rows.speaker.extra, el('div', { class: 'chk-ask' }, play, yes, no));
          playTone().catch(() => {});
        });
        UI.render(rows.speaker.extra);
        return heard ? R('pass', '聽得到') : R('fail', '聽不到聲音。請檢查音量、耳機有沒有插好，或換一個播放裝置');
      });

      // 麥克風：權限 + 實際收音。失敗的話直接把「怎麼解」畫在這一列底下，
      // 並給一顆只重測麥克風的按鈕 —— 為了一項失敗把整份重跑一次太浪費。
      await step('mic', runMicStep);

      await step('ws', checkWs);
      await step('turnstile', checkTurnstile);

      running = false;
      runBtn.disabled = false;
      runBtn.textContent = '重新檢查';
      await finish();
    }

    /** 跑麥克風那一項；失敗時附上可以照做的步驟與重測鈕 */
    async function runMicStep() {
      const meter = el('div', { class: 'chk-meter' }, el('i'));
      UI.render(rows.mic.extra,
        el('div', {},
          el('div', { class: 'small muted' }, '請對著麥克風說話，例如唸「一、二、三」'),
          meter));

      const r = await checkMic((level, peak) => {
        meter.firstChild.style.width = `${Math.round(level * 100)}%`;
        meter.firstChild.className = peak > 0.06 ? 'ok' : '';
      });

      if (r.status === 'pass') { UI.render(rows.mic.extra); return r; }

      const retry = el('button', {
        class: 'btn sm primary',
        onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = '測試中…';
          const again = await step('mic', runMicStep);
          if (again.status === 'pass') await finish();
        },
      }, '🎙 再測一次麥克風');

      const p = micSettingsPath();
      const steps = r.kind === 'policyHeader'
        ? el('div', {},
            el('p', {}, '這一項學生自己改不了，請把下面這段給架站的人：'),
            S.ppHeader
              ? el('p', {}, '這一頁實際收到的標頭是：',
                  el('code', { style: { userSelect: 'all' } }, S.ppHeader))
              : null,
            el('ol', {},
              el('li', {}, '考試系統本身送的是 ', el('code', {}, 'microphone=(self)'),
                '（允許），所以多出來的限制幾乎都來自',
                el('b', {}, '反向代理或 Cloudflare'), '。'),
              el('li', {}, 'Nginx：找設定檔裡的 ', el('code', {}, 'add_header Permissions-Policy'),
                '，把 ', el('code', {}, 'microphone=()'), ' 拿掉或改成 ',
                el('code', {}, 'microphone=(self)'), '。',
                el('br'),
                el('span', { class: 'small' },
                  '⚠️ nginx 的 ', el('code', {}, 'add_header'),
                  ' 有繼承陷阱：只要子 location 裡有任何一個 add_header，父層那些就全部失效。'
                  + '改完記得每一層都確認。')),
              el('li', {}, 'Cloudflare：Rules → Transform Rules → Modify Response Header，'
                + '以及 Managed Transforms，看有沒有加上 Permissions-Policy。'),
              el('li', {}, '改完在伺服器上確認：',
                el('code', { style: { userSelect: 'all' } },
                  `curl -sI ${location.origin} | grep -i permissions-policy`),
                '　應該只看到一行，而且含 ', el('code', {}, 'microphone=(self)'), '。')),
            el('p', { class: 'small muted' },
              'Safari 沒有實作這個標頭的麥克風限制，所以「Safari 可以、Chrome 不行」正是這個問題的典型症狀 —— '
              + 'Safari 能用不代表設定沒問題，正式考試用 Chrome 的學生一樣會卡住。'))
        : r.kind === 'insecure'
        ? el('div', {},
            el('p', {}, '這一項不是學生自己能解決的，請把下面這段給老師或管理員：'),
            el('ol', {},
              el('li', {}, '瀏覽器規定只有 ', el('code', {}, 'https://'), ' 或 ',
                el('code', {}, 'localhost'), ' 才給麥克風權限，這是安全規範，沒有例外或開關可以繞過。'),
              el('li', {}, '目前的考試網址是 ', el('code', {}, location.origin),
                '，請替它加上 HTTPS（Nginx／Caddy 反向代理 + Let\'s Encrypt 憑證）。'),
              /^(localhost|127\.|\[::1\])/.test(location.hostname) ? null
                : el('li', {}, '臨時要在跑系統的那台機器上先測的話，可以改用 ',
                  el('code', {}, `http://localhost:${location.port || 80}`), ' 開啟。')))
        : r.kind === 'blocked'
          ? el('div', {},
              el('p', {}, '瀏覽器已經記住「封鎖」了，所以不會再跳出詢問視窗。兩個方法擇一：'),
              el('ol', {},
                el('li', {}, '點網址列最左邊的圖示（鎖頭 🔒 或 ⓘ 或滑桿），找到「麥克風」改成「允許」。'),
                el('li', {}, p.how, p.url ? el('span', {}, '，把 ',
                  el('code', { style: { userSelect: 'all' } }, location.origin),
                  ' 從「不允許」清單移除') : '')),
              el('p', { class: 'small muted' }, '改好之後不用重新整理，直接按下面的按鈕就好。'))
          : r.kind === 'policy'
            ? el('div', {},
                el('p', {}, '這台電腦被系統層級擋住了，學生自己改不了。請把下面這段給資訊組：'),
                el('ol', {},
                  el('li', {}, '檢查作業系統的麥克風隱私設定有沒有整個關掉（Windows：設定 → 隱私權與安全性 → 麥克風）。'),
                  el('li', {}, '檢查有沒有群組原則／MDM 停用了瀏覽器的媒體擷取（如 Chrome 的 ',
                    el('code', {}, 'AudioCaptureAllowed'), ' 政策）。'),
                  el('li', {}, '把 ', el('code', { style: { userSelect: 'all' } }, location.origin),
                    ' 加進 ', el('code', {}, 'AudioCaptureAllowedUrls'), ' 允許清單。')))
            : el('div', {},
                el('p', {}, '按下面的按鈕，瀏覽器會再問一次 —— 這次請選「允許」。'),
                el('p', { class: 'small muted' },
                  '詢問視窗會出現在網址列下方，有時候會被忽略。如果沒看到，先確認瀏覽器視窗是不是被其他程式蓋住了。'));

      UI.render(rows.mic.extra, el('div', { class: 'chk-fix' }, steps, el('div', { class: 'toolbar' }, retry)));
      return r;
    }

    async function finish() {
      const fails = order.filter((id) => results[id]?.status === 'fail');
      const warns = order.filter((id) => results[id]?.status === 'warn');
      const micOk = results.mic?.status === 'pass';
      const criticalFail = fails.filter((id) => cfg.checks[id]?.critical);

      let saved = null;
      try { saved = await API.post('/check', { results }); } catch { /* 存不進去不影響學生 */ }

      writePass({ micOk, ok: !fails.length, code: saved?.code || null });

      const label = (id) => cfg.checks[id]?.label || id;
      verdict.className = `chk-verdict ${criticalFail.length ? 'fail' : (fails.length || warns.length) ? 'warn' : 'pass'}`;
      UI.render(verdict,
        el('h3', {}, criticalFail.length
          ? '這台電腦還不能考試'
          : fails.length || warns.length ? '可以考，但有幾點要處理' : '✓ 這台電腦沒問題'),
        criticalFail.length
          ? el('p', {}, '以下是',  el('b', {}, '一定要解決'), '的：',
              el('ul', {}, criticalFail.map((id) => el('li', {}, el('b', {}, label(id)), ' — ', results[id].note))))
          : null,
        fails.filter((id) => !cfg.checks[id]?.critical).length
          ? el('ul', {}, fails.filter((id) => !cfg.checks[id]?.critical)
              .map((id) => el('li', {}, el('b', {}, label(id)), ' — ', results[id].note)))
          : null,
        warns.length
          ? el('ul', { class: 'muted' }, warns.map((id) => el('li', {}, `${label(id)} — ${results[id].note}`)))
          : null,
        saved?.code
          ? el('p', { class: 'small muted' }, '診斷碼 ',
              el('code', { style: { userSelect: 'all', fontSize: '1.1em' } }, saved.code),
              ' —— 有問題時把這組碼報給老師，老師查得到細節。')
          : null);

      UI.render(actions,
        runBtn,
        el('button', {
          class: 'btn',
          onclick: () => {
            const text = [`IELTS 考前環境檢查（${new Date().toLocaleString('zh-TW')}）`,
              saved?.code ? `診斷碼：${saved.code}` : '',
              `瀏覽器：${S.browser || '?'}　視窗：${S.screen || '?'}`,
              ...order.filter((id) => results[id] && results[id].status !== 'skip')
                .map((id) => `${ICON[results[id].status]} ${label(id)}${results[id].note ? `：${results[id].note}` : ''}`),
            ].filter(Boolean).join('\n');
            navigator.clipboard?.writeText(text)
              .then(() => UI.toast('已複製，可以貼給老師', 'ok'))
              .catch(() => UI.alert(text));
          },
        }, '複製結果'),
        gate && onDone
          ? el('button', {
              class: criticalFail.length ? 'btn' : 'btn primary',
              onclick: async () => {
                if (criticalFail.length) {
                  const go = await UI.confirm(
                    `還有 ${criticalFail.length} 項必要檢查沒過（${criticalFail.map(label).join('、')}）。`
                    + '硬要開始的話，考試中很可能會出問題，而且處理權限時的離開紀錄會留在老師那邊。確定要繼續嗎？',
                    '我知道，還是要開始');
                  if (!go) return;
                }
                onDone();
              },
            }, criticalFail.length ? '略過檢查，直接開始' : '開始考試')
          : null,
        !gate && API.token ? el('a', { class: 'btn', href: '#/' }, '回首頁') : null,
        !gate && !API.token ? el('a', { class: 'btn', href: '#/login' }, '去登入') : null);

      onDone && !gate && onDone(results);
    }

    runBtn.onclick = runAll;
    return { runAll };
  }

  return { render, recentlyPassed, readPass, writePass, VERSION, PASS_KEY };
})();
