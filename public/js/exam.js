/* ═══════════════════════════════════════════════════════════
   考試執行畫面 — 比照 IELTS 官方機考
   頂列（姓名/編號・計時器可隱藏・Help・Settings）
   指示語帶 → 作答區 → 底部 Review + Part 題號列 + 上下題箭頭
   右鍵螢光筆與註記、字級與高對比配色、10/5 分鐘警告
   ═══════════════════════════════════════════════════════════ */
const Exam = (() => {
  const { el, sanitize, fmtTime, toast } = UI;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = () => document.getElementById('app');

  let S = null;
  let tick = null;
  let syncTick = null;
  let pending = new Map();
  let saveTimer = null;

  // ── 個人化設定（跨場次記住）────────────────────────────
  const PREF_KEY = 'ielts_cbt_prefs';
  const prefs = Object.assign({ size: 'standard', scheme: 'standard' }, (() => {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; }
  })());
  const savePrefs = () => localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  /* 注意是 querySelectorAll：對話框（.cbt-dim）也會帶著 `cbt` 這個 class，
     不然它掛在 body 上就吃不到配色變數。而學生正是在「顯示設定」這個對話框
     裡面換配色的 —— 只改第一個 .cbt 的話，他按下黑底黃字，背後的考卷變了，
     手上這個對話框卻還是白的，看起來就像設定沒生效。 */
  function applyPrefs() {
    document.querySelectorAll('.cbt').forEach((c) => {
      c.dataset.size = prefs.size;
      c.dataset.scheme = prefs.scheme;
    });
  }

  // ── 官方風格對話框 ──────────────────────────────────────
  /**
   * 對話框。
   *
   * 一定要掛在 document.body，不能掛在 .cbt 裡面。
   *
   * 畫面上每一次重畫都是 `root().replaceChildren(...)` —— 掛在 .cbt 裡的
   * 對話框會跟著被整個拔掉，而那個 Promise **永遠不會 resolve**。
   * 呼叫端幾乎都是 `const ok = await dlg(...)`，於是那一行卡死在那裡：
   * 按鈕按下去毫無反應，也沒有任何錯誤訊息。
   * 「結束這一科」「離開」「結束測驗」這些按鈕失靈都是這樣來的。
   *
   * 掛在 body 之後還要再保一層：萬一 dim 真的被外力移除，也要把 Promise
   * 收掉，不能讓呼叫端永遠停在 await。
   */
  function dlg({ title, body, actions = [], dismissable = false }) {
    return new Promise((resolve) => {
      let done = false;
      /* 一定要帶著 `cbt` 這個 class。所有配色變數（--c-bg / --c-line /
         --c-accent / --cbt-font）都定義在 .cbt 上 —— 掛到 body 之後
         如果不帶，對話框會完全失去背景、外框與字級，學生看到的是一塊
         沒有樣式的白字浮在畫面上，OK 也不像按鈕。
         順便把學生選的字級與配色一起複製過來，高對比模式才不會破功。 */
      const dim = el('div', { class: 'cbt cbt-dim' });
      const host = document.querySelector('.cbt:not(.cbt-dim)');
      if (host) {
        if (host.dataset.size) dim.dataset.size = host.dataset.size;
        if (host.dataset.scheme) dim.dataset.scheme = host.dataset.scheme;
      }
      const finish = (v) => {
        if (done) return;
        done = true;
        obs.disconnect();
        dim.remove();
        resolve(v);
      };
      dim.append(el('div', { class: 'cbt-dialog' },
        el('h3', {}, title),
        el('div', { class: 'bd' }, body),
        actions.length && el('div', { class: 'ft' }, actions.map((a) =>
          el('button', {
            class: `cbt-btn ${a.primary ? 'primary' : ''}`,
            onclick: () => { if (a.onClick && a.onClick(dim) === false) return; finish(a.value); },
          }, a.label)))));
      /* 點遮罩。可關的就關掉；不可關的至少要讓對話框動一下。
         這個遮罩是 inset:0 z-index:1300，開著的時候畫面上每一顆按鈕
         都點不動 —— 這是刻意的，但如果學生沒注意到有對話框，症狀就是
         「整頁的按鈕全部沒反應」，而且完全沒有線索。抖一下至少告訴他
         「有東西在等你回答」。 */
      dim.addEventListener('click', (e) => {
        if (e.target !== dim) return;
        if (dismissable) return finish(null);
        const box = dim.firstElementChild;
        box.classList.remove('nudge');
        void box.offsetWidth;              // 重新觸發動畫
        box.classList.add('nudge');
      });
      // 被別人從 DOM 拔掉時，也要讓 await 回得來
      const obs = new MutationObserver(() => { if (!dim.isConnected) finish(null); });
      document.body.append(dim);
      obs.observe(document.body, { childList: true });
      guardVisible(dim);
    });
  }

  /**
   * 對話框一定要看得見。
   *
   * 這層保險是被上一個 bug 逼出來的：對話框搬到 body 之後失去了
   * .cbt 上的配色變數，畫出來是一塊透明的東西 —— 但遮罩照樣蓋滿整個
   * 畫面、照樣吃掉所有點擊。學生看到的是「口說考到一半，畫面上每一顆
   * 按鈕都點不動」，看不出跟對話框有任何關係，也沒有任何錯誤訊息。
   *
   * 樣式表沒載到、被舊快取蓋掉、日後又有人把它搬走，都會再走到同一個
   * 結果。所以畫完之後實際量一次，不對就直接補行內樣式 —— 醜一點沒關係，
   * 至少學生看得到、按得掉，不會被鎖在一個沒有出口的畫面裡。
   */
  function guardVisible(dim) {
    requestAnimationFrame(() => {
      if (!dim.isConnected) return;
      const box = dim.firstElementChild;
      if (!box) return;
      const r = box.getBoundingClientRect();
      const see = getComputedStyle(box).backgroundColor;
      const invisible = /^(transparent|rgba\(0, 0, 0, 0\))$/.test(see);
      if (r.width >= 80 && r.height >= 60 && !invisible) return;

      console.warn('[cbt] 對話框沒有正常畫出來，改用行內樣式（樣式表可能沒載到或是舊的）');
      Object.assign(dim.style, {
        position: 'fixed', inset: '0', zIndex: '1300', display: 'grid',
        placeItems: 'center', padding: '1rem', background: 'rgba(0,0,0,.45)',
      });
      Object.assign(box.style, {
        width: 'min(560px, 92vw)', maxHeight: '86vh', overflow: 'auto',
        background: '#fff', color: '#1c1c1c', border: '1px solid #b9b9b9',
        boxShadow: '0 6px 28px rgba(0,0,0,.35)',
        font: '15px/1.6 system-ui, -apple-system, "Noto Sans TC", sans-serif',
      });
      $$('h3', box).forEach((h) => Object.assign(h.style, {
        margin: '0', padding: '.7rem 1rem', background: '#f2f2f2',
        borderBottom: '1px solid #b9b9b9', fontSize: '1em',
      }));
      $$('.bd', box).forEach((b) => Object.assign(b.style, { padding: '1rem' }));
      $$('.ft', box).forEach((f) => Object.assign(f.style, {
        padding: '.7rem 1rem', borderTop: '1px solid #b9b9b9',
        display: 'flex', gap: '.5rem', justifyContent: 'flex-end',
      }));
      $$('button', box).forEach((b) => Object.assign(b.style, {
        padding: '.4rem 1rem', cursor: 'pointer', font: 'inherit',
        border: '1px solid #b9b9b9', background: '#fff', color: '#1c1c1c',
      }));
      $$('button.primary', box).forEach((b) => Object.assign(b.style, {
        background: '#005c8a', color: '#fff', borderColor: '#005c8a', fontWeight: '700',
      }));
    });
  }
  const notice = (title, body) => dlg({ title, body, actions: [{ label: 'OK', primary: true, value: true }] });
  const ask = (title, body, ok = '確定') => dlg({
    title, body, actions: [{ label: '取消', value: false }, { label: ok, primary: true, value: true }],
  });

  // ── 進入考試 ────────────────────────────────────────────
  async function open(attemptId) {
    document.body.style.overflow = 'hidden';
    root().replaceChildren(el('div', { class: 'cbt' }, el('div', { class: 'cbt-center' },
      el('div', { class: 'cbt-card' }, el('h2', {}, '載入考卷中…')))));

    let data;
    try {
      data = await API.get(`/exam/${attemptId}`);
    } catch (e) {
      document.body.style.overflow = '';
      await notice('無法開始考試', e.message);
      location.hash = '#/';
      return;
    }

    S = {
      attemptId, attempt: data.attempt, paper: data.paper,
      state: data.state || { modules: {} },
      // 老師在指派時設定的規則：每科時間、反作弊、休息政策
      rules: data.rules || { durations: {}, proctoring: { enabled: false }, break: { policy: 'flexible' } },
      leaveCount: Number(data.leaveCount || 0),
      answers: {}, review: {}, writing: {}, writingDirty: {},
      module: null, section: 0, current: null, endsAt: null,
      warned: {},
      // 螢光筆／註記：key = `科目:段落:區塊`，值是 [{hid,start,end,note}]
      marks: (data.state?.ui?.marks && typeof data.state.ui.marks === 'object') ? data.state.ui.marks : {},
      nextHid: 1,   // 下面依還原的資料重算，避免和既有畫記撞號
      counts: data.counts, savedSpeaking: data.saved.speaking || [],
      timerHidden: false,
    };
    S.nextHid = Math.max(0, ...Object.values(S.marks).flat().map((r) => Number(r.hid) || 0)) + 1;

    for (const m of ['listening', 'reading']) { S.answers[m] = {}; S.review[m] = new Set(); }
    for (const a of data.saved.answers || []) {
      S.answers[a.module] = S.answers[a.module] || {};
      S.review[a.module] = S.review[a.module] || new Set();
      S.answers[a.module][a.q_number] = a.response ?? '';
      if (a.flagged) S.review[a.module].add(Number(a.q_number));
    }
    for (const w of data.saved.writing || []) S.writing[w.task_no] = w.essay || '';

    setupProctoring();
    const anyStarted = Object.keys(S.state.modules || {}).length > 0;
    if (anyStarted) renderModuleList();
    else renderConfirmDetails();
  }

  function leave() {
    stopTimer();
    exitFullscreen();
    document.body.style.overflow = '';
    location.hash = '#/';
  }

  // ── 反作弊 ──────────────────────────────────────────────
  const proc = () => S?.rules?.proctoring || {};

  async function reportEvent(type, detail = '') {
    try {
      const r = await API.post(`/exam/${S.attemptId}/event`, { type, module: S.module, detail });
      if (typeof r.leaveCount === 'number') S.leaveCount = r.leaveCount;
      return r;
    } catch { return {}; }
  }

  function requestFullscreen() {
    const e = document.documentElement;
    const fn = e.requestFullscreen || e.webkitRequestFullscreen || e.msRequestFullscreen;
    return fn ? fn.call(e).catch(() => {}) : Promise.resolve();
  }
  function exitFullscreen() {
    if (!document.fullscreenElement) return;
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
  }

  let violationOpen = false;
  async function onViolation(type, label) {
    if (!S || !S.module) return;
    const p = proc();
    if (!p.enabled) return;
    const r = await reportEvent(type, label);
    // 伺服器會判斷這一次算不算違規（口說本來就不要求全螢幕、
    // 或學生剛回報過麥克風權限被拒、正在處理權限）。判定不算的話
    // 就不要跳紀律警告 —— 系統自己造成的中斷，不該讓學生以為自己被抓。
    if (r.excused) return;
    const count = r.leaveCount ?? S.leaveCount;

    // 超過上限的處置。真正的判定與收卷在伺服器，這裡只是把結果講給學生聽；
    // 前端自己再算一次是為了離線或請求失敗時也還有提醒。
    const overLimit = r.autoSubmitted
      || (p.maxLeaves > 0 && p.onExceed === 'submit' && count > p.maxLeaves);
    if (overLimit) {
      await notice('已自動結束這一科', el('div', {},
        el('p', {}, `你離開考試畫面 ${count} 次，已超過老師設定的上限（${p.maxLeaves} 次）。`),
        el('p', {}, '這一科已自動收卷，紀錄會提供給老師。')));
      return finishModule(true);
    }

    if (!p.warnOnLeave || violationOpen) return;
    violationOpen = true;
    // 「上限 2 次」的意思是還可以離開 2 次，第 3 次才處置。
    const left = r.remaining ?? (p.maxLeaves > 0 ? Math.max(0, p.maxLeaves - count + 1) : null);
    const over = p.maxLeaves > 0 ? `（第 ${count} 次，上限 ${p.maxLeaves} 次）` : `（第 ${count} 次）`;
    await notice('考試紀律提醒', el('div', {},
      el('p', {}, el('b', {}, `偵測到你${label}${over}`)),
      el('p', {}, '考試進行中請勿切換分頁、視窗或離開全螢幕，這些行為都會被記錄下來給老師。'),
      p.maxLeaves > 0 && p.onExceed === 'submit' && left != null
        ? el('p', { style: { color: '#c0392b' } }, `再離開 ${left} 次，這一科就會自動收卷。`)
        : null));
    violationOpen = false;
    if (p.requireFullscreen && !document.fullscreenElement) await ensureFullscreen();
  }

  async function ensureFullscreen() {
    if (document.fullscreenElement) return true;
    const ok = await dlg({
      title: '請回到全螢幕',
      body: el('div', {},
        el('p', {}, '這場考試設定為全螢幕作答。'),
        el('p', {}, '按下方按鈕回到全螢幕就可以繼續。')),
      actions: [{ label: '回到全螢幕', primary: true, value: true }],
    });
    if (ok) { await requestFullscreen(); reportEvent('fullscreen_enter'); }
    return !!document.fullscreenElement;
  }

  function setupProctoring() {
    if (S._proctorBound) return;
    S._proctorBound = true;

    // 「離開」是一個狀態，不是一連串事件。
    //
    // 切一次分頁，瀏覽器會先送 blur、再送 visibilitychange，兩個監聽器
    // 各記一次，於是學生只切走一次卻被記成兩次。老師設「允許離開 2 次、
    // 超過自動收卷」，學生第一次切分頁就直接被收卷。
    // 現在改成：出去記一次，回來才重新開始算。
    let away = false;
    function markAway(label) {
      if (away || !S || !S.module || !proc().enabled) return;
      away = true;
      onViolation('leave', label);
    }
    function markBack() {
      if (!away) return;
      away = false;
      if (S?.module && proc().enabled) reportEvent('return');
    }

    document.addEventListener('visibilitychange', () => {
      if (!S || !S.module) return;
      // 回到前景先對時。背景期間計時器被節流成一分鐘一次，
      // 「時間到該收卷」那一刻很可能整個被跳過。
      if (document.visibilityState === 'visible') syncTime();
      // 沒開監考就完全不要回報。以前 return 沒有被 proc().enabled 擋住，
      // 於是關掉監考的考試照樣一路寫 exam_events，而那張表沒有任何清理機制。
      if (!proc().enabled) return;
      if (document.visibilityState === 'hidden') markAway('切換到其他分頁或視窗');
      else markBack();
    });

    window.addEventListener('focus', markBack);

    window.addEventListener('blur', () => {
      if (!S || !S.module || document.visibilityState === 'hidden') return;
      // 只有真的切走才算，點擊 iframe 之類的忽略
      setTimeout(() => {
        if (document.hasFocus() || !S.module) return;
        markAway('離開考試視窗');
      }, 400);
    });

    document.addEventListener('fullscreenchange', () => {
      if (!S || !S.module || !proc().enabled || !proc().requireFullscreen) return;
      // startModule 本來就不會在口說時要求全螢幕，判定這裡也要跟著排除，
      // 否則前一科帶進來的全螢幕一退出就記一筆，學生根本沒被要求過。
      if (S.module === 'speaking') return;
      if (!document.fullscreenElement) onViolation('fullscreen_exit', '離開全螢幕');
    });

    // 擋複製：文章與題目區不能複製走
    document.addEventListener('copy', (e) => {
      if (!S?.module || !proc().enabled || !proc().blockCopy) return;
      if (!e.target.closest?.('.cbt-pane, .cbt-passage')) return;
      if (e.target.matches?.('textarea, input')) return;   // 自己寫的作文可以複製
      e.preventDefault();
      reportEvent('copy_blocked', '嘗試複製題目內容');
      toast('這場考試不允許複製題目內容', 'err');
    });
    document.addEventListener('cut', (e) => {
      if (!S?.module || !proc().enabled || !proc().blockCopy) return;
      if (e.target.matches?.('textarea, input')) return;
      e.preventDefault();
    });

    // 擋貼上：避免把事先寫好的作文貼進來
    document.addEventListener('paste', (e) => {
      if (!S?.module || !proc().enabled || !proc().blockCopy) return;
      if (!e.target.matches?.('textarea, input')) return;
      e.preventDefault();
      reportEvent('paste_blocked', '嘗試貼上內容');
      toast('這場考試不允許貼上，請自己輸入', 'err');
    });
  }

  // ── 外殼 ────────────────────────────────────────────────
  function shell(...children) {
    const c = el('div', { class: 'cbt' }, ...children);
    root().replaceChildren(c);
    applyPrefs();
    return c;
  }

  function topBar({ withTools = true } = {}) {
    return el('div', { class: 'cbt-top' },
      el('div', { class: 'cbt-cand' },
        el('b', {}, API.user?.name || '考生'),
        el('span', {}, `— ${API.user?.candidateNo || API.user?.username || ''}`)),
      el('div', { class: 'grow' }),
      withTools && el('div', { class: 'cbt-clock', id: 'cbt-clock' },
        el('span', {}, '🕐'), el('span', { class: 't' }, '--:--'), el('span', { class: 'small' }, ' left')),
      withTools && el('button', {
        class: 'cbt-tool', title: '隱藏／顯示計時器',
        onclick: () => {
          S.timerHidden = !S.timerHidden;
          $('#cbt-clock')?.classList.toggle('hidden-time', S.timerHidden);
          $('#hide-lbl').textContent = S.timerHidden ? 'Show' : 'Hide';
        },
      }, el('span', { id: 'hide-lbl' }, 'Hide')),
      withTools && el('button', {
        class: 'cbt-tool', id: 'note-count', title: '看我寫過的註記',
        style: { visibility: 'hidden', pointerEvents: 'none' },   // 位置先佔著，不要讓右邊整排跳
        onclick: showAllNotes,
      }, '📝'),
      el('button', { class: 'cbt-tool', onclick: showHelp }, '❓ Help'),
      el('button', { class: 'cbt-tool', onclick: showSettings }, '⚙ Settings'));
  }

  // ── 設定與說明 ──────────────────────────────────────────
  function showSettings() {
    const sizes = [['standard', '標準 Standard'], ['large', '大 Large'], ['xlarge', '特大 Extra large']];
    const schemes = [
      ['standard', '標準（白底黑字）', '#fff', '#1c1c1c'],
      ['black-yellow', '黃底黑字', '#fff9c4', '#1a1a1a'],
      ['yellow-black', '黑底黃字', '#1a1a1a', '#ffe95c'],
      ['white-black', '黑底白字', '#1a1a1a', '#f5f5f5'],
    ];
    const mk = (list, key, render) => {
      const box = el('div', { class: 'cbt-radioline' });
      const paint = () => $$('label', box).forEach((l) => l.classList.toggle('sel', l.dataset.v === prefs[key]));
      list.forEach((item) => {
        const v = item[0];
        box.append(el('label', {
          dataset: { v },
          onclick: () => { prefs[key] = v; savePrefs(); applyPrefs(); paint(); },
        }, render(item)));
      });
      paint();
      return box;
    };

    dlg({
      title: 'Settings　顯示設定',
      body: el('div', {},
        el('div', {}, el('b', {}, '文字大小 Text size')),
        mk(sizes, 'size', ([, label]) => el('span', {}, label)),
        el('div', {}, el('b', {}, '配色 Colour')),
        mk(schemes, 'scheme', ([, label, bg, fg]) => [
          el('span', { class: 'swatch', style: { background: bg, color: fg, borderColor: fg } }),
          el('span', {}, label),
        ]),
        el('p', { class: 'small' }, '設定會記住，下次考試自動沿用。')),
      actions: [{ label: '關閉', primary: true, value: true }],
    });
  }

  function showHelp() {
    notice('Help　操作說明', el('div', {},
      el('p', {}, el('b', {}, '作答：'), '選擇題直接點選，填空題直接輸入，答案會自動儲存。'),
      el('p', {}, el('b', {}, '題號列：'), '畫面最下方。深色＝已作答，橘點＝已標記 Review，外框＝目前這題。點 Part 名稱可切換段落。'),
      el('p', {}, el('b', {}, 'Review：'), '左下角的核取方塊可以把目前這題標記起來，稍後回頭檢查。'),
      el('p', {}, el('b', {}, '箭頭：'), '右下角 ◀ ▶ 可以上一題／下一題。'),
      el('p', {}, el('b', {}, '螢光筆與註記：'),
        '選取文字後按滑鼠右鍵，可以選擇 Highlight（畫線）或 Notes（加註記）。'
        + '文章、題目、寫作題目都可以畫，畫記會一直留到這一科結束，'
        + '換段落、重新整理都不會消失。右上角的 📝 可以一次看完所有註記。'),
      el('p', {}, el('b', {}, 'Settings：'), '可調整文字大小與高對比配色。'),
      el('p', {}, el('b', {}, '字數限制：'), 'ONE WORD / NO MORE THAN TWO WORDS 等限制務必遵守，超過一律不給分。')));
  }

  // ── 開場：確認個人資料（官方流程）──────────────────────
  function renderConfirmDetails() {
    shell(
      topBar({ withTools: false }),
      el('div', { class: 'cbt-center' },
        el('div', { class: 'cbt-card' },
          el('h2', {}, 'Confirm your details　確認個人資料'),
          el('p', {}, '請確認以下資料正確。若有誤請通知監考老師。'),
          el('div', { class: 'info' },
            el('div', {}, el('span', {}, 'Name 姓名'), el('span', {}, API.user?.name || '')),
            el('div', {}, el('span', {}, 'Candidate number 考生編號'), el('span', {}, API.user?.candidateNo || API.user?.username || '')),
            el('div', {}, el('span', {}, 'Test 試卷'), el('span', {}, S.paper.title)),
            el('div', {}, el('span', {}, 'Module 類型'), el('span', {}, S.paper.testType === 'general' ? 'General Training' : 'Academic'))),
          el('div', { class: 'cbt-actions' },
            el('button', { class: 'cbt-btn primary', onclick: renderModuleList }, '資料正確，繼續 →'),
            el('button', { class: 'cbt-btn', onclick: leave }, '離開')))));
  }

  /** 把老師設定的規則清楚寫給學生看，免得考到一半才發現 */
  function rulesBanner() {
    const p = proc();
    const b = S.rules.break || {};
    const lines = [];
    if (S.rules.extraTimePct > 0) lines.push(`⏱ 這場考試有 ${S.rules.extraTimePct}% 的額外作答時間`);
    if (b.policy === 'official') lines.push('▶ 聽力、閱讀、寫作會連續進行，中間不休息（官方流程）');
    if (b.policy === 'timed') lines.push(`☕ 每一科之間有 ${Math.round((b.seconds || 0) / 60)} 分鐘休息，時間到自動進入下一科`);
    if (p.enabled) {
      const bits = [];
      if (p.requireFullscreen) bits.push('必須全螢幕作答');
      if (p.blockCopy) bits.push('不能複製題目、不能貼上');
      bits.push(p.maxLeaves > 0
        ? `離開畫面上限 ${p.maxLeaves} 次${p.onExceed === 'submit' ? '，超過自動收卷' : ''}`
        : '離開畫面會被記錄');
      lines.push(`🔒 監考模式：${bits.join('、')}`);
    }
    if (!lines.length) return null;
    return el('div', { class: 'info', style: { marginTop: '.8rem' } },
      lines.map((t) => el('div', { style: { display: 'block' } }, t)));
  }

  const moduleOf = (n) => (S.paper.modules || []).find((m) => m.module === n);
  const mstate = (n) => S.state.modules?.[n] || {};
  const isDone = (n) => { const s = mstate(n); return !!(s.finished || (s.endsAt && Date.now() > s.endsAt)); };

  // ── 科目清單 ────────────────────────────────────────────
  function renderModuleList() {
    stopTimer();
    const mods = S.attempt.modules;
    const allDone = mods.every(isDone);

    shell(
      topBar({ withTools: false }),
      el('div', { class: 'cbt-center' },
        el('div', { class: 'cbt-card' },
          el('h2', {}, S.paper.title),
          el('p', { class: 'small' }, '一次考一科。每一科開始後計時就不會停止，中途關閉頁面時間仍會繼續走。'),

          rulesBanner(),

          el('div', { style: { margin: '1.1rem 0' } }, mods.map((m) => {
            const mod = moduleOf(m);
            const secs = S.rules.durations?.[m] ?? ((mod?.durationSec || 0) + (mod?.transferSec || 0));
            const mins = Math.round(secs / 60);
            const bd = S.rules.breakdown?.[m];
            const done = isDone(m);
            const started = !!mstate(m).endsAt && !done;
            return el('div', {
              style: {
                display: 'flex', alignItems: 'center', gap: '1rem',
                padding: '.7rem 0', borderBottom: '1px solid var(--c-line-soft)',
              },
            },
              el('div', { style: { flex: '1 1 auto' } },
                el('b', {}, UI.MODULE_LABEL[m]),
                el('div', { class: 'small', style: { opacity: '.7' } },
                  `${mins} 分鐘`,
                  bd?.extraSec ? `（含加時 ${Math.round(bd.extraSec / 60)} 分）` : '',
                  m === 'listening' ? ` · ${mod.sections.length} 個 Part` : '',
                  m === 'reading' ? ` · ${mod.sections.length} 篇文章` : '')),
              done
                ? el('span', { class: 'small' }, '✓ 已完成')
                : el('button', {
                    class: 'cbt-btn primary',
                    onclick: () => beginModule(m),
                  }, started ? '繼續作答' : '開始'));
          })),

          allDone
            ? el('div', {},
                el('p', {}, el('b', {}, '所有科目都完成了。'), ' 按下方按鈕正式交卷，系統會立刻開始批改。'),
                el('div', { class: 'cbt-actions' },
                  el('button', { class: 'cbt-btn primary', onclick: submitAll }, '交卷並取得成績')))
            : el('p', { class: 'small', style: { opacity: '.7' } }, '完成所有科目後才能交卷。'),

          el('div', { class: 'cbt-actions' },
            el('button', { class: 'cbt-btn', onclick: leave }, '← 離開（進度會保留）')))));
  }

  // ── 開始一科 ────────────────────────────────────────────
  async function beginModule(name) {
    if (name === 'listening' && !mstate(name).endsAt) return renderSoundCheck(name);
    return startModule(name);
  }

  function renderSoundCheck(name) {
    const testTone = () => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 440;
        g.gain.value = 0.12;
        o.connect(g); g.connect(ctx.destination);
        o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 900);
      } catch { toast('無法播放測試音'); }
    };
    const firstAudio = moduleOf('listening')?.sections?.find((s) => s.audio)?.audio;

    shell(
      topBar({ withTools: false }),
      el('div', { class: 'cbt-center' },
        el('div', { class: 'cbt-card' },
          el('h2', {}, 'Sound check　耳機測試'),
          el('p', {}, '聽力音檔只會播放一次，開始前請先確認可以清楚聽到聲音。'),
          el('div', { class: 'cbt-actions' },
            el('button', { class: 'cbt-btn', onclick: testTone }, '🔊 播放測試音'),
            firstAudio && el('button', {
              class: 'cbt-btn',
              onclick: (e) => {
                const a = new Audio(firstAudio);
                a.volume = 0.8;
                a.play().then(() => setTimeout(() => a.pause(), 4000))
                  .catch(() => toast('找不到音檔，請通知老師', 'err'));
                e.target.textContent = '播放中…';
                setTimeout(() => { e.target.textContent = '▶ 試聽前 4 秒'; }, 4200);
              },
            }, '▶ 試聽前 4 秒')),
          el('p', { class: 'small', style: { marginTop: '1rem' } },
            '調整好電腦或耳機音量後再繼續。考試中畫面上也有音量調整。'),
          el('div', { class: 'cbt-actions' },
            el('button', { class: 'cbt-btn primary', onclick: () => startModule(name) }, '我聽得很清楚，開始考試'),
            el('button', { class: 'cbt-btn', onclick: renderModuleList }, '返回')))));
  }

  async function startModule(name) {
    // 監考模式要求全螢幕：趁著使用者這一次點擊（瀏覽器只允許在點擊時進全螢幕）
    if (proc().enabled && proc().requireFullscreen && name !== 'speaking') {
      await requestFullscreen();
      reportEvent('fullscreen_enter', '進入全螢幕');
    }

    let info;
    try {
      info = await API.post(`/exam/${S.attemptId}/module/start`, { module: name });
    } catch (e) { return notice('無法開始', e.message); }

    S.state.modules[name] = { startedAt: info.startedAt, endsAt: info.endsAt, durationSec: info.durationSec };
    // endsAt 是伺服器的時鐘。學生電腦的時鐘慢十分鐘就多考十分鐘，
    // 快十分鐘則一進去就被判定時間到 —— 這裡把差距記下來校正。
    if (info.serverTime) S.skew = info.serverTime - Date.now();
    S.module = name;
    S.section = 0;
    S.current = null;
    S.warned = {};

    if (name === 'speaking') {
      // 口說要跟瀏覽器要麥克風權限，全螢幕底下權限提示很容易被忽略或看不到。
      // 這一科本來就沒要求全螢幕，乾脆主動退出來。
      exitFullscreen();
      Speaking.run({
        attemptId: S.attemptId,
        paper: S.paper,
        mode: S.attempt.speakingGrading || 'ai',
        saved: S.savedSpeaking,
        prefs,
        onDone: async () => {
          await API.post(`/exam/${S.attemptId}/module/finish`, { module: 'speaking' }).catch(() => {});
          S.state.modules.speaking = { ...(S.state.modules.speaking || {}), finished: true };
          S.module = null;
          renderModuleList();
        },
      });
      return;
    }

    const qs = flat(name);
    S.current = qs[0]?.number ?? null;
    renderExam();
    startTimer(info.endsAt);
  }

  // ── 計時 ────────────────────────────────────────────────
  /** 伺服器現在幾點（用開始作答時量到的時鐘差校正）*/
  const serverNow = () => Date.now() + (S.skew || 0);

  function startTimer(endsAt) {
    stopTimer();
    S.endsAt = endsAt;
    S.expiring = false;
    const upd = () => {
      const leftSec = Math.max(0, (S.endsAt - serverNow()) / 1000);
      const c = $('#cbt-clock');
      if (c) {
        const mins = Math.ceil(leftSec / 60);
        c.querySelector('.t').textContent = leftSec > 60 ? `${mins} minutes` : fmtTime(leftSec);
        c.className = 'cbt-clock' + (leftSec <= 60 ? ' danger' : leftSec <= 300 ? ' warn' : '') +
          (S.timerHidden ? ' hidden-time' : '');
      }
      for (const m of [10, 5, 1]) {
        if (!S.warned[m] && leftSec <= m * 60 && leftSec > m * 60 - 2) {
          S.warned[m] = true;
          notice('提醒', el('p', {}, `You have ${m} minute${m > 1 ? 's' : ''} left.　剩下 ${m} 分鐘。`));
        }
      }
      if (leftSec <= 0 && !S.expiring) { S.expiring = true; stopTimer(); finishModule(true); }
    };
    upd();
    tick = setInterval(upd, 500);

    /* 每 20 秒跟伺服器對一次時。
       兩件事非做不可：一是學生的電腦時鐘可能一直在漂；二是分頁切到背景時
       瀏覽器會把計時器節流到一分鐘一次，回來的那一刻可能早就過了收卷時間。
       而且伺服器自己也會收卷 —— 它收掉了，這裡要立刻跟上，不能讓學生
       繼續對著一份已經結束的考卷作答。 */
    clearInterval(syncTick);
    syncTick = setInterval(() => {
      syncTime();
      // 沒存出去的要一直重試，不能等學生下次剛好改到題目才有機會補送
      if (pending.size || Object.keys(S.writingDirty || {}).length) flush();
    }, 20000);
  }

  async function syncTime() {
    if (!S?.attemptId || !S.module) return;
    let t;
    try { t = await API.get(`/exam/${S.attemptId}/time`); } catch { return; }
    if (!S || !S.module) return;
    S.skew = t.serverTime - Date.now();
    const m = t.modules?.[S.module];
    if (!m) return;
    if (m.endsAt) S.endsAt = m.endsAt;
    // 伺服器那邊已經收掉了（時間到、或整份被自動交卷）
    if ((m.finished || t.status !== 'in_progress') && !S.expiring) {
      S.expiring = true;
      stopTimer();
      const stuck = pending.size + Object.keys(S.writingDirty || {}).length;
      await notice('時間到', el('div', {},
        el('p', {}, `「${UI.MODULE_LABEL[S.module] || S.module}」的作答時間已經結束，系統已經幫你收卷。`),
        stuck
          ? el('p', { style: { color: 'var(--c-danger)', fontWeight: '700' } },
            `注意：有 ${stuck} 筆作答沒有成功存到伺服器，請立刻告訴監考老師。`)
          : el('p', { class: 'small', style: { opacity: '.75' } }, '已經作答的內容都有存下來。')));
      finishModule(true);
    }
  }

  function stopTimer() {
    if (tick) clearInterval(tick);
    tick = null;
    clearInterval(syncTick);
    syncTick = null;
  }

  async function finishModule(auto = false) {
    if (!auto) {
      const ok = await ask('結束這一科',
        el('p', {}, `確定要結束「${UI.MODULE_LABEL[S.module]}」嗎？結束後就不能再修改答案。`), '結束');
      if (!ok) return;
    }
    $$('.cbt-lightbox').forEach((n) => n.remove());
    await flush();
    // 結束前再試一次，並且把「有沒有東西沒存出去」帶到結束畫面上
    if (pending.size || Object.keys(S.writingDirty || {}).length) await flush();
    const unsaved = pending.size + Object.keys(S.writingDirty || {}).length;
    const name = S.module;
    try { await API.post(`/exam/${S.attemptId}/module/finish`, { module: name }); } catch {}
    S.state.modules[name] = { ...(S.state.modules[name] || {}), finished: true };
    stopTimer();
    S.module = null;

    const qs = flat(name);
    const answered = qs.filter((q) => String(S.answers[name]?.[q.number] ?? '').trim()).length;

    // 依老師設定的休息政策決定接下來怎麼走
    const b = S.rules.break || { policy: 'flexible' };
    const chain = b.chain || null;
    const nextInChain = chain
      ? chain.find((m) => m !== name && chain.indexOf(m) > chain.indexOf(name) && !isDone(m))
      : null;

    shell(
      topBar({ withTools: false }),
      el('div', { class: 'cbt-center' },
        el('div', { class: 'cbt-card' },
          el('h2', {}, auto ? '時間到　Time is up' : `${UI.MODULE_LABEL[name]} 已結束`),
          auto ? el('p', {}, '這一科的作答時間已經結束，系統已自動收卷。') : null,
          name !== 'writing'
            ? el('p', {}, `共 ${qs.length} 題，你作答了 `, el('b', {}, String(answered)), ' 題。')
            /* 以前這句是無條件寫死的。存不出去的時候學生看到的還是
               「你的作文已儲存」，然後這一科就被鎖死了。 */
            : el('p', {}, unsaved ? '你的作文可能沒有完整儲存。' : '你的作文已儲存。'),
          unsaved
            ? el('p', { style: { color: 'var(--c-danger)', fontWeight: '700' } },
              `注意：有 ${unsaved} 筆內容沒有成功存到伺服器，請立刻告訴監考老師。`)
            : null,
          el('p', { class: 'small', style: { opacity: '.7' } }, '成績要等全部科目考完、正式交卷後才會公布。'),
          el('div', { class: 'cbt-actions' },
            nextInChain
              ? el('button', {
                  class: 'cbt-btn primary',
                  onclick: () => renderBreak(nextInChain, 0),
                }, `繼續 ${UI.MODULE_LABEL[nextInChain]} →`)
              : el('button', { class: 'cbt-btn primary', onclick: renderModuleList }, '回到科目清單 →')))));

    // 官方流程／固定休息：不讓學生停在這一頁，自動往下走
    if (nextInChain) {
      const wait = b.policy === 'official' ? (b.seconds || 15) : (b.seconds || 0);
      setTimeout(() => { if (!S.module) renderBreak(nextInChain, wait); }, 1500);
    }
  }

  /** 科目之間的過場／休息畫面，倒數結束自動進入下一科 */
  function renderBreak(nextModule, seconds) {
    const official = (S.rules.break?.policy) === 'official';
    let left = Math.max(0, Number(seconds) || 0);

    const go = () => { clearInterval(t); startModule(nextModule); };

    shell(
      topBar({ withTools: false }),
      el('div', { class: 'cbt-center' },
        el('div', { class: 'cbt-card', style: { textAlign: 'center' } },
          el('h2', {}, official ? '下一科即將開始' : '休息時間　Break'),
          el('p', {}, '接下來是 ', el('b', {}, UI.MODULE_LABEL[nextModule]),
            `，時限 ${Math.round((S.rules.durations?.[nextModule] || 0) / 60)} 分鐘。`),
          official
            ? el('p', { class: 'small', style: { opacity: '.75' } },
                '依照雅思官方流程，聽力、閱讀、寫作之間不安排休息，請留在座位上。')
            : el('p', { class: 'small', style: { opacity: '.75' } },
                '休息時間結束會自動開始下一科，請不要離開電腦。'),
          left > 0
            ? el('div', { class: 'cbt-bigtimer', id: 'break-timer' }, fmtTime(left))
            : null,
          el('div', { class: 'cbt-actions', style: { justifyContent: 'center' } },
            el('button', { class: 'cbt-btn primary', onclick: go }, '現在就開始 →')))));

    const t = setInterval(() => {
      left -= 1;
      const n = $('#break-timer');
      if (n) {
        n.textContent = fmtTime(Math.max(0, left));
        n.className = 'cbt-bigtimer' + (left <= 10 ? ' danger' : left <= 60 ? ' warn' : '');
      }
      if (left <= 0) go();
    }, 1000);
    if (left <= 0) setTimeout(go, 1200);
  }

  async function submitAll() {
    const ok = await ask('確定交卷',
      el('p', {}, '交卷後系統會開始批改，寫作與口說的 AI 評分需要一點時間。確定要交卷嗎？'), '交卷');
    if (!ok) return;
    await flush();
    try {
      await API.post(`/exam/${S.attemptId}/submit`, {});
      stopTimer();
      exitFullscreen();
      document.body.style.overflow = '';
      location.hash = `#/result/${S.attemptId}`;
    } catch (e) { notice('交卷失敗', e.message); }
  }

  // ── 儲存 ────────────────────────────────────────────────
  function queue(module, number) {
    pending.set(`${module}:${number}`, {
      module, number,
      response: S.answers[module]?.[number] ?? '',
      flagged: S.review[module]?.has(Number(number)) ? 1 : 0,
    });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 900);
  }

  /**
   * 送出待存的作答。
   *
   * 以前這裡有三個會讓學生整段作答無聲消失的問題：
   *   · 送出**之前**就 pending.clear()，失敗之後沒有任何地方把它放回去，
   *     也沒有重試。一次 Wi-Fi 漫遊就吃掉那 900 毫秒內的所有題目。
   *   · 寫作連那個 3 秒的提示都沒有（catch 是空的），而且只要學生停止
   *     打字，writingDirty 就不會再被填回去 —— 那一段永遠不會再送出。
   *     然後結束畫面還直接寫「你的作文已儲存。」
   *   · 伺服器把答案退掉（該科已結束、已被自動收卷）時照樣回 200 並附上
   *     rejected 清單，前端從來不看，題號列照樣顯示已作答。
   *
   * 現在一律「成功才清掉」，失敗放回去等下一次重試，並且把狀態顯示出來。
   */
  async function flush() {
    clearTimeout(saveTimer);
    const items = [...pending.values()];
    const essays = Object.entries(S.writingDirty || {});
    if (!items.length && !essays.length) { paintSaveState(); return; }
    const jobs = [];

    if (items.length) {
      jobs.push(API.post(`/exam/${S.attemptId}/answers`, { items }).then((r) => {
        items.forEach((it) => {
          // 期間又改過的不要覆蓋掉
          const k = `${it.module}:${it.number}`;
          if (pending.get(k) === it) pending.delete(k);
        });
        const rej = r?.rejected || [];
        if (rej.length) onRejected(rej);
      }, () => { S.saveFailed = true; }));
    }
    for (const [taskNo, essay] of essays) {
      jobs.push(API.post(`/exam/${S.attemptId}/writing`, { taskNo: Number(taskNo), essay }).then(() => {
        if (S.writingDirty?.[taskNo] === essay) delete S.writingDirty[taskNo];
      }, () => { S.saveFailed = true; }));
    }
    await Promise.all(jobs);
    const stuck = pending.size + Object.keys(S.writingDirty || {}).length;
    S.saveFailed = stuck > 0;
    if (S.saveFailed && !S.saveWarned) {
      S.saveWarned = true;
      toast('答案還沒存到伺服器，系統會持續重試 —— 請確認網路', 'err');
    }
    if (!S.saveFailed) S.saveWarned = false;
    paintSaveState();
  }

  /** 伺服器收到卻不接受（該科已結束／已被自動收卷）—— 這種事必須讓學生知道 */
  function onRejected(rej) {
    if (S.rejectedWarned) return;
    S.rejectedWarned = true;
    notice('這一科已經結束', el('div', {},
      el('p', {}, el('b', {}, `伺服器沒有接受你最近的 ${rej.length} 題作答。`)),
      el('p', {}, rej[0]?.reason || '這一科的作答時間已經結束。'),
      el('p', {}, '請不要再繼續作答，並告訴監考老師。')));
  }

  /** 把「存好了／還沒存出去」直接寫在畫面上，不要只靠一閃而過的提示 */
  function paintSaveState() {
    const n = $('#save-state');
    if (!n) return;
    const stuck = pending.size + Object.keys(S.writingDirty || {}).length;
    n.textContent = stuck ? `⚠ 有 ${stuck} 筆還沒存出去（重試中）` : '已自動儲存';
    n.style.color = stuck ? 'var(--c-danger)' : '';
    n.style.fontWeight = stuck ? '700' : '';
  }

  function setAnswer(module, number, value) {
    S.answers[module] = S.answers[module] || {};
    S.answers[module][number] = value;
    S.current = Number(number);
    queue(module, number);
    refreshFoot();
  }

  function toggleReview(number) {
    const m = S.module;
    const set = (S.review[m] = S.review[m] || new Set());
    const n = Number(number);
    if (set.has(n)) set.delete(n); else set.add(n);
    queue(m, n);
    refreshFoot();
  }

  // ── 題目攤平 ────────────────────────────────────────────
  function flat(name) {
    const mod = moduleOf(name);
    const out = [];
    if (!mod) return out;
    mod.sections.forEach((sec, si) => {
      sec.groups.forEach((g, gi) => {
        if (['writing_task', 'speaking_part'].includes(g.type)) return;
        g.questions.forEach((q) => out.push({ ...q, type: g.type, si, gi, group: g }));
      });
    });
    return out.sort((a, b) => a.number - b.number);
  }

  // ── 主畫面 ──────────────────────────────────────────────
  function renderExam(keepScroll = false) {
    // 重畫會把註記框連根拔掉，先把打到一半的字收下來（任何觸發路徑都涵蓋到）
    commitOpenNote();
    const scroll = keepScroll ? ($('.cbt-pane.right')?.scrollTop ?? $('.cbt-pane.single')?.scrollTop ?? 0) : 0;
    const passScroll = $('#pane-passage')?.scrollTop ?? 0;
    const splitFlex = $('.cbt-pane.left')?.style.flex || S._splitFlex || '';
    S._splitFlex = splitFlex;
    const name = S.module;
    const mod = moduleOf(name);
    const sec = mod.sections[S.section] || mod.sections[0];

    const stage = name === 'writing' ? writingStage()
      : name === 'reading' ? readingStage(sec)
      : listeningStage(sec);

    shell(topBar(), bandBar(name, sec), stage, footBar());

    if (keepScroll && scroll) {
      const p = $('.cbt-pane.right') || $('.cbt-pane.single');
      if (p) {
        p.scrollTop = scroll;
        // 內容還沒排版完時 scrollTop 會被夾成 0，下一幀再補一次
        requestAnimationFrame(() => { if (p.isConnected && p.scrollTop !== scroll) p.scrollTop = scroll; });
      }
    }
    if (name === 'reading' || name === 'writing') {
      // 左欄的捲動位置以前完全沒有還原 —— 學生畫一條線，文章就跳回最上面
      const lp = $('#pane-passage');
      if (lp && passScroll) {
        lp.scrollTop = passScroll;
        requestAnimationFrame(() => { if (lp.isConnected && lp.scrollTop !== passScroll) lp.scrollTop = passScroll; });
      }
    }
    refreshFoot();
    if (name === 'reading' || name === 'writing') setupSplit(name === 'writing' && !!sec && hasFigure(name));
    if (name === 'listening') setupAudio(sec);
    // 畫記在重畫後要塗回去 —— 這是官方機考的行為，畫記整科都留著
    setupContextMenu();
    restoreMarks();
    refreshNoteCount();
    paintSaveState();
    auditQuestions(name);
  }

  /**
   * 畫完之後對一次帳：底部題號列有的題目，作答區是不是真的都畫出來了。
   *
   * 這一類「題目被吞掉」的問題全部長得一樣 —— 題庫看得到、底部題號列
   * 看得到、該有的地方就是沒有，而且沒有任何錯誤訊息。學生只會覺得
   * 「這份考卷怪怪的」，然後那幾題直接 0 分。實測一次吞掉 5 題。
   *
   * 與其一個一個成因去堵，不如在畫完之後直接數一遍。少了就大聲講，
   * 並且回報給伺服器，讓老師事後查得到是哪一份試卷、哪幾題。
   */
  function auditQuestions(name) {
    if (!S || !S.module) return;
    const want = flat(name).filter((q) => q.si === S.section)
      .map((q) => Number(q.number)).filter(Number.isFinite);
    const missing = want.filter((n) => !document.getElementById(`q-${n}`));
    const box = $('#q-audit');
    if (box) box.remove();
    if (!missing.length) return;

    const pane = $('.cbt-pane.right') || $('.cbt-pane.single');
    if (pane) {
      pane.prepend(el('div', {
        id: 'q-audit', class: 'cbt-rubric',
        style: { borderColor: 'var(--c-danger)', color: 'var(--c-danger)', fontWeight: '700' },
      },
        el('span', { class: 'rng' }, '⚠ 這一頁有題目沒有正常顯示'),
        `第 ${missing.join('、')} 題應該出現在這一頁，但沒有畫出來。`
        + '請立刻舉手告訴監考老師 —— 這是試卷的問題，不是你的操作問題。'));
    }
    if (!S._auditSent) S._auditSent = new Set();
    const key = `${name}:${S.section}:${missing.join(',')}`;
    if (S._auditSent.has(key)) return;
    S._auditSent.add(key);
    reportEvent('render_gap', `${name} 第 ${S.section + 1} 段：第 ${missing.join('、')} 題沒有畫出來`);
  }

  function bandBar(name, sec) {
    const label = name === 'reading' ? `Reading Passage ${S.section + 1}`
      : name === 'listening' ? `Part ${S.section + 1}`
      : 'Writing';
    const qs = flat(name).filter((q) => q.si === S.section);
    const range = qs.length ? `Questions ${qs[0].number}–${qs[qs.length - 1].number}` : '';
    return el('div', { class: 'cbt-band' },
      el('b', {}, label, range ? ` — ${range}` : ''),
      el('span', {}, sec?.instructions
        || (name === 'listening' ? 'Listen and answer the questions.'
          : name === 'reading' ? 'Read the passage and answer the questions.' : '')));
  }

  // ── 聽力 ────────────────────────────────────────────────
  function listeningStage(sec) {
    return el('div', { class: 'cbt-stage' },
      el('div', { class: 'cbt-pane single' },
        el('div', { class: 'inner' },
          audioBar(sec),
          sec.image ? figure(sec.image, sec.title || '本節圖片') : null,
          sec.groups.map((g, gi) => renderGroup('listening', g, S.section, gi)))));
  }

  /**
   * 圖片的版面保險。
   *
   * 這些 <img> 沒有 width/height 也沒有 aspect-ratio，高度要等檔案載完才
   * 確定。聽力的地圖／平面圖就夾在音檔列與所有題目之間 —— 圖片一載完，
   * 底下每一個選項與填空框整批往下移數百 px，而學生正在趕答題（聽力
   * 一進畫面就開始播）。載失敗時舊寫法是 display:none，高度又縮回去，
   * 等於再跳一次。
   *
   * 作法：CSS 先給一塊 min-height 佔位，載完（或載失敗）再標記 data-loaded
   * 讓它收掉；失敗改用 visibility 而不是 display，位置至少不會再變。
   */
  /**
   * 考卷裡的圖（Task 1 圖表、地圖、平面圖、流程圖）。
   *
   * 以前這些 <img> 直接輸出，只有 `.cbt-group img.fig` 那一條 CSS 有
   * max-width —— 而寫作 Task 1 的圖表不在 .cbt-group 裡面，於是**完全沒有
   * 任何寬度限制**。一張 1600×900 的長條圖就原尺寸畫出來，右邊超出容器
   * 981px、下面超出視窗 276px。學生看到的是圖表的左上角：兩根長條、
   * 沒有年份、沒有圖例、沒有單位 —— 這題根本沒辦法作答。
   *
   * 光是縮到容器內還不夠：Task 1 的圖表被塞進 50% 寬的欄位只剩約 39%，
   * 座標軸的字會小到看不清楚。官方機考給圖表的空間大得多。所以：
   *   · 縮到容器內、保持比例、不超過視窗高度
   *   · 可以點開放大（全螢幕檢視、可縮放、可拖曳）
   *   · 寫作的分隔線也改成真的可以拖（以前是裝飾用的）
   */
  function figure(src, alt) {
    const img = el('img', {
      class: 'cbt-fig', src, alt: alt || '',
      title: '點一下可以放大',
      onclick: () => lightbox(src, alt),
      ...imgGuard(),
    });
    return el('figure', { class: 'cbt-figwrap' },
      img,
      el('figcaption', {},
        el('button', {
          class: 'cbt-btn cbt-zoom',
          onclick: (e) => { e.stopPropagation(); lightbox(src, alt); },
        }, '🔍 放大檢視')));
  }

  /**
   * 放大檢視。掛在 document.body（跟對話框同一個理由：畫面每一次重畫都是
   * root().replaceChildren()，掛在裡面會被連根拔掉），而且要自己帶 `cbt`
   * 才吃得到配色變數。
   */
  function lightbox(src, alt) {
    const host = document.querySelector('.cbt:not(.cbt-dim):not(.cbt-lightbox)');
    const box = el('div', { class: 'cbt cbt-lightbox' });
    if (host) {
      if (host.dataset.size) box.dataset.size = host.dataset.size;
      if (host.dataset.scheme) box.dataset.scheme = host.dataset.scheme;
    }
    let zoom = 1;
    let panX = 0; let panY = 0;
    const img = el('img', { src, alt: alt || '', draggable: 'false' });
    const paint = () => {
      img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
      img.style.cursor = zoom > 1 ? 'grab' : 'zoom-in';
    };
    const setZoom = (z) => {
      zoom = Math.min(6, Math.max(1, z));
      if (zoom === 1) { panX = 0; panY = 0; }
      paint();
    };
    const close = () => {
      box.remove();
      document.removeEventListener('keydown', onKey);
    };
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === '+' || e.key === '=') setZoom(zoom + 0.5);
      else if (e.key === '-') setZoom(zoom - 0.5);
    }
    // 滾輪縮放；拖曳平移
    img.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 0.3 : -0.3)); }, { passive: false });
    let drag = null;
    img.addEventListener('pointerdown', (e) => {
      if (zoom <= 1) return;
      drag = { x: e.clientX - panX, y: e.clientY - panY };
      img.setPointerCapture(e.pointerId);
      img.style.cursor = 'grabbing';
    });
    img.addEventListener('pointermove', (e) => {
      if (!drag) return;
      panX = e.clientX - drag.x; panY = e.clientY - drag.y; paint();
    });
    img.addEventListener('pointerup', () => { drag = null; paint(); });
    img.addEventListener('dblclick', () => setZoom(zoom > 1 ? 1 : 2));

    box.append(
      el('div', { class: 'bar' },
        el('span', { class: 'ttl' }, alt || '圖表'),
        el('span', { style: { flex: 1 } }),
        el('button', { class: 'cbt-btn', onclick: () => setZoom(zoom - 0.5) }, '－'),
        el('button', { class: 'cbt-btn', onclick: () => setZoom(1) }, '原始大小'),
        el('button', { class: 'cbt-btn', onclick: () => setZoom(zoom + 0.5) }, '＋'),
        el('button', { class: 'cbt-btn primary', onclick: close }, '關閉')),
      el('div', { class: 'stage', onclick: (e) => { if (e.target.classList.contains('stage')) close(); } }, img));
    document.body.append(box);
    document.addEventListener('keydown', onKey);
    paint();
  }

  const imgGuard = () => ({
    onload: (e) => { e.target.dataset.loaded = '1'; },
    onerror: (e) => { e.target.dataset.loaded = '1'; e.target.style.visibility = 'hidden'; },
  });

  function audioBar(sec) {
    if (!sec.audio) return el('div', { class: 'cbt-audio' }, el('span', { class: 'st' }, '（本 Part 沒有音檔）'));
    /* 這裡只畫「狀態列」，不畫 <audio>。
       播放器本體掛在 document.body 底下（見 audioEl），因為畫面上任何
       一次重畫都是 root().replaceChildren() —— <audio> 一旦離開 document，
       瀏覽器依規範必須把它暫停。以前它就畫在這裡面，於是學生在聽力時
       只要右鍵畫一條螢光筆、存一則註記，聲音就永遠停掉，而狀態列還會
       寫「本 Part 音檔已播過（只播放一次）」，看起來完全像是系統照規則
       在運作。那個 Part 的十題等於整組作廢，畫面上沒有任何錯誤。 */
    return el('div', { class: 'cbt-audio' },
      el('span', { class: 'st', id: 'aud-st' }, '準備播放'),
      el('div', { class: 'bar' }, el('i', { id: 'aud-pg' })),
      el('span', {}, '🔊'),
      el('input', {
        type: 'range', min: 0, max: 1, step: 0.05, value: audioEl() ? audioEl().volume : 1, id: 'aud-vol',
        oninput: (e) => { const a = audioEl(); if (a) a.volume = Number(e.target.value); },
      }));
  }

  /** 常駐的播放器。永遠掛在 body 上，不隨畫面重畫而生滅。 */
  function audioEl() { return S?._aud || null; }
  function dropAudio() {
    if (!S?._aud) return;
    try { S._aud.pause(); } catch { /* 已經沒了就算了 */ }
    S._aud.remove();
    S._aud = null;
  }

  function setupAudio(sec) {
    if (!sec?.audio) { dropAudio(); return; }
    const audioState = (S.state.audio = S.state.audio || {});
    const key = `s${S.section}`;
    const st = () => $('#aud-st');
    const say = (t) => { const n = st(); if (n) n.textContent = t; };

    let a = S._aud;
    if (!a) {
      a = el('audio', { preload: 'auto', style: { display: 'none' } });
      document.body.append(a);
      S._aud = a;
      // 監聽器只掛一次；要更新的節點都在觸發當下才去找，重畫過也還是對的
      a.addEventListener('timeupdate', () => {
        const pg = $('#aud-pg');
        if (pg && a.duration) pg.style.width = `${(a.currentTime / a.duration) * 100}%`;
        audioState[`s${S.section}`] = a.currentTime;
      });
      a.addEventListener('error', () => {
        // 這一則要留住。以前它會在 200 毫秒內被 play() 的失敗訊息蓋掉，
        // 學生最後看到的是「播放中…」配上一片寂靜。
        a.dataset.failed = '1';
        say('音檔載入失敗，請通知老師');
        reportEvent('audio_error', `第 ${S.section + 1} 段音檔載入失敗`);
      });
      a.addEventListener('ended', () => {
        say('本 Part 音檔已播畢');
        const mod = moduleOf('listening');
        if (S.section < mod.sections.length - 1) {
          setTimeout(() => {
            if (!S || S.module !== 'listening') return;
            commitOpenNote();          // 學生正在打的註記不能被這一下吃掉
            S.section += 1;
            S.current = flat('listening').find((q) => q.si === S.section)?.number ?? S.current;
            renderExam(true);
          }, 1500);
        }
      });
      // 官方規則：不能倒轉
      a.addEventListener('seeking', () => {
        const back = audioState[`s${S.section}`] || 0;
        if (a.currentTime < back - 0.6) a.currentTime = back;
      });
    }

    if (a.dataset.src !== sec.audio) {
      a.dataset.src = sec.audio;
      delete a.dataset.failed;
      a.src = sec.audio;
    }
    const vol = $('#aud-vol');
    if (vol) vol.value = String(a.volume);

    if (a.dataset.failed) return say('音檔載入失敗，請通知老師');
    if (audioState[`${key}_played`]) {
      // 重畫回來的時候如果還在播，就不要謊稱已經播完了
      return say(a.paused ? '本 Part 音檔已播過（只播放一次）' : '播放中…');
    }
    say('播放中…');
    a.play().then(
      // 真的播出去了才記成「播過」。以前是先記再播，載入失敗的話
      // 學生連重試的入口都沒有。
      () => { audioState[`${key}_played`] = true; },
      () => {
        /* 「載入失敗」跟「瀏覽器擋自動播放」是兩件完全不同的事，給的指示
           也不一樣。以前一律說「請點畫面任一處開始播放」—— 音檔 404 的時候
           那個 error 事件講的實話會在幾十毫秒內被這一句蓋掉，學生點了畫面
           之後狀態還會變成「播放中…」配上一片寂靜。 */
        if (a.dataset.failed || a.error || a.networkState === 3) {
          a.dataset.failed = '1';
          return say('音檔載入失敗，請通知老師');
        }
        say('請點畫面任一處開始播放');
        const go = () => {
          if (a.dataset.failed || a.error) return say('音檔載入失敗，請通知老師');
          a.play().then(() => { audioState[`${key}_played`] = true; say('播放中…'); },
            () => say('音檔播不出來，請通知老師'));
        };
        document.addEventListener('click', go, { once: true });
      });
  }

  // ── 閱讀 ────────────────────────────────────────────────
  function readingStage(sec) {
    return el('div', { class: 'cbt-stage' },
      el('div', { class: 'cbt-pane left cbt-passage', id: 'pane-passage' },
        el('h2', {}, sec.passageTitle || sec.title),
        sec.source && el('div', { class: 'sub' }, sec.source),
        // 素材編輯器的「本節圖片（地圖／平面圖）」以前沒有任何地方讀，
        // 老師填了等於丟進黑洞，學生看到的是空白
        sec.image ? figure(sec.image, sec.title || '本節圖片') : null,
        el('div', { html: sanitize(sec.passage || '<p>（沒有文章內容）</p>') })),
      el('div', { class: 'cbt-split', id: 'splitter' }),
      el('div', { class: 'cbt-pane right' },
        sec.groups.map((g, gi) => renderGroup('reading', g, S.section, gi))));
  }

  /* 分隔線。
     兩個以前的問題：
     · 拖出來的寬度只寫在行內樣式上，沒有存起來 —— 任何一次重畫（畫一條線、
       存一則註記）欄寬就跳回 50%，右邊整批選項與填空框跟著水平位移，
       學生下一次點擊的目標已經換了位置。
     · window 的 mouseup/mousemove 每次重畫都再掛一組、從不移除，重畫幾十次
       之後同一個事件會跑幾十遍。 */
  let splitDrag = false;
  let splitBound = false;
  /** 這一科目前這一頁有沒有圖 */
  function hasFigure(name) {
    if (name === 'writing') return !!(S.writingTasks?.[S.section]?.image);
    return false;
  }
  function setupSplit(wideDefault = false) {
    const sp = $('#splitter');
    const left = $('#pane-passage');
    if (!sp || !left) return;
    /* 有圖表的時候左欄預設給多一點。Task 1 的長條圖在 50% 欄位裡只剩約 37%，
       座標軸的字幾乎看不清楚 —— 而學生不會知道那根分隔線可以拖。 */
    if (!S._splitFlex && wideDefault) S._splitFlex = '0 0 60%';
    if (S._splitFlex) left.style.flex = S._splitFlex;
    const move = (x) => {
      const pct = Math.min(78, Math.max(22, (x / window.innerWidth) * 100));
      const l = $('#pane-passage');
      if (!l) return;
      S._splitFlex = `0 0 ${pct}%`;
      l.style.flex = S._splitFlex;
    };
    sp.addEventListener('mousedown', (e) => { splitDrag = true; e.preventDefault(); document.body.style.cursor = 'col-resize'; });
    sp.addEventListener('touchmove', (e) => { move(e.touches[0].clientX); }, { passive: true });
    if (splitBound) return;
    splitBound = true;
    window.addEventListener('mouseup', () => { splitDrag = false; document.body.style.cursor = ''; });
    window.addEventListener('mousemove', (e) => { if (splitDrag) move(e.clientX); });
  }

  /* ═══════════════════════════════════════════════════════════
     螢光筆與註記

     畫記不能存在 DOM 裡。作答、換段落、重新整理都會把畫面重畫一次，
     存在 DOM 的 <mark> 會跟著被清掉 —— 官方機考裡畫記是整科都留著的。

     所以改成記「文字位移」：每一筆畫記存成該區塊純文字裡的 {start, end}，
     重畫之後再依位移重新塗上去。位移只跟題目內容有關，重畫幾次都一樣。
     ═══════════════════════════════════════════════════════════ */

  // 可以畫記的區塊。key 用來分別存放，換科換段落互不干擾。
  const MARK_SCOPES = [
    { sel: '#pane-passage', scope: 'passage' },              // 閱讀文章
    { sel: '.cbt-pane.right:not(.cbt-write)', scope: 'questions' },  // 閱讀題目（寫作右欄是作答區，不畫）
    { sel: '.cbt-pane.single', scope: 'questions' },          // 聽力題目
    { sel: '.cbt-pane.left:not(.cbt-passage)', scope: 'prompt' },    // 寫作題目
  ];

  const scopeOf = (host) => MARK_SCOPES.find((s) => $(s.sel) === host)?.scope || 'questions';

  const markKey = (scope) => `${S.module}:${S.section}:${scope}`;

  /** 區塊裡所有可以畫記的文字節點（textarea/input 不算） */
  function textNodes(host) {
    const out = [];
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || ['TEXTAREA', 'SCRIPT', 'STYLE', 'INPUT', 'OPTION'].includes(p.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  }

  /** DOM 位置 → 純文字位移 */
  function offsetIn(host, container, offset) {
    const nodes = textNodes(host);
    if (container.nodeType === 1) {
      const child = container.childNodes[offset];
      let pos = 0;
      for (const n of nodes) {
        if (child && (n === child || child.contains(n))) return pos;
        pos += n.nodeValue.length;
      }
      return pos;
    }
    let pos = 0;
    for (const n of nodes) {
      if (n === container) return pos + offset;
      pos += n.nodeValue.length;
    }
    return -1;
  }

  /**
   * 依文字位移把 [start, end) 塗上顏色。
   * 跨段落時會逐個文字節點分別包起來 —— 舊版用 extractContents 一次包，
   * 只要選取跨越了段落就會失敗，只能跳出「這段文字沒辦法畫線」。
   */
  function paintRange(host, start, end, hid, note) {
    const segments = [];
    let pos = 0;
    for (const n of textNodes(host)) {
      const len = n.nodeValue.length;
      const s = Math.max(start, pos);
      const e = Math.min(end, pos + len);
      if (e > s && !n.parentElement.closest('mark.hl')) {
        segments.push({ node: n, s: s - pos, e: e - pos });
      }
      pos += len;
      if (pos >= end) break;
    }
    // 由後往前包，前面的文字節點才不會被切開影響
    const made = [];
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const { node, s, e } = segments[i];
      const r = document.createRange();
      try {
        r.setStart(node, s);
        r.setEnd(node, e);
        const m = document.createElement('mark');
        m.className = 'hl';
        m.dataset.hid = String(hid);
        r.surroundContents(m);
        made.push(m);
      } catch { /* 這一小段包不起來就跳過，其他照樣畫 */ }
    }
    made.reverse();
    if (note && made[0]) {
      made.forEach((m) => m.classList.add('has-note'));
      made[0].dataset.note = note;
      made[0].title = note;
    }
    made.forEach((m) => m.addEventListener('click', () => {
      const rec = findMark(host, m.dataset.hid);
      if (rec?.note) openNote(host, m, rec);
    }));
    return made;
  }

  function listFor(host) {
    const key = markKey(scopeOf(host));
    if (!S.marks[key]) S.marks[key] = [];
    return S.marks[key];
  }

  const findMark = (host, hid) => listFor(host).find((r) => String(r.hid) === String(hid));

  /** 重畫之後把畫記塗回去 */
  function restoreMarks() {
    for (const { sel } of MARK_SCOPES) {
      const host = $(sel);
      if (!host) continue;
      for (const rec of listFor(host)) paintRange(host, rec.start, rec.end, rec.hid, rec.note);
    }
  }

  function saveMarks() {
    API.post(`/exam/${S.attemptId}/state`, { ui: { marks: S.marks } }).catch(() => {});
    refreshNoteCount();
  }

  // ── 右鍵選單 ────────────────────────────────────────────
  let menuEl = null;
  function closeMenu() { menuEl?.remove(); menuEl = null; }

  function setupContextMenu() {
    for (const { sel } of MARK_SCOPES) {
      const host = $(sel);
      if (!host || host.dataset.hlReady) continue;
      host.dataset.hlReady = '1';
      host.addEventListener('contextmenu', (e) => {
        const mark = e.target.closest('mark.hl');
        const s = window.getSelection();
        const hasSel = s && !s.isCollapsed && host.contains(s.anchorNode);
        if (!mark && !hasSel) return;      // 沒選字也沒點到畫記 → 用瀏覽器原生選單
        e.preventDefault();
        openMenu(e.clientX, e.clientY, { mark, host });
      });
    }
    document.addEventListener('click', closeMenu);
    document.addEventListener('scroll', closeMenu, true);
  }

  function openMenu(x, y, { mark, host }) {
    closeMenu();
    const items = [];
    if (!mark) {
      items.push(['🖍 Highlight　畫線', () => addMark(host, false)]);
      items.push(['📝 Notes　加註記', () => addMark(host, true)]);
    } else {
      const rec = findMark(host, mark.dataset.hid);
      items.push([rec?.note ? '📝 編輯註記' : '📝 加註記', () => openNote(host, mark, rec)]);
      items.push(['✖ 清除這一段', () => removeMark(host, mark.dataset.hid)]);
    }
    if (listFor(host).length) {
      items.push(['🧽 清除這一頁全部畫記', () => {
        S.marks[markKey(scopeOf(host))] = [];
        renderExam(true);
        saveMarks();
      }]);
    }

    menuEl = el('div', { class: 'cbt-menu', style: { left: `${x}px`, top: `${y}px` } },
      items.map(([label, fn], i) => [
        i === items.length - 1 && items.length > 1 ? el('hr') : null,
        el('button', { onclick: (e) => { e.stopPropagation(); closeMenu(); fn(); } }, label),
      ]));
    (document.querySelector('.cbt') || document.body).append(menuEl);

    const r = menuEl.getBoundingClientRect();
    if (r.right > innerWidth) menuEl.style.left = `${innerWidth - r.width - 8}px`;
    if (r.bottom > innerHeight) menuEl.style.top = `${innerHeight - r.height - 8}px`;
  }

  function addMark(host, withNote) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const start = offsetIn(host, range.startContainer, range.startOffset);
    const end = offsetIn(host, range.endContainer, range.endOffset);
    sel.removeAllRanges();
    if (start < 0 || end <= start) return;

    const list = listFor(host);
    // 和既有畫記重疊就合併，避免一層包一層
    const overlap = list.filter((r) => r.start < end && r.end > start);
    const rec = {
      hid: S.nextHid++,
      start: Math.min(start, ...overlap.map((o) => o.start)),
      end: Math.max(end, ...overlap.map((o) => o.end)),
      note: overlap.map((o) => o.note).filter(Boolean).join('\n') || null,
    };
    for (const o of overlap) list.splice(list.indexOf(o), 1);
    list.push(rec);
    list.sort((a, b) => a.start - b.start);

    renderExam(true);
    saveMarks();
    if (withNote) {
      const m = $(`mark.hl[data-hid="${rec.hid}"]`);
      if (m) openNote(host, m, rec);
    }
  }

  function removeMark(host, hid) {
    const list = listFor(host);
    const i = list.findIndex((r) => String(r.hid) === String(hid));
    if (i >= 0) list.splice(i, 1);
    renderExam(true);
    saveMarks();
  }

  /* 目前開著的註記框。任何一次重畫都會把它連同還沒存的文字一起拔掉 ——
     聽力的音檔播完會自動換段重畫，那正是學生剛聽完、在寫筆記的時候。
     所以重畫之前一律先把打到一半的內容收下來。 */
  let openNoteRef = null;
  function commitOpenNote() {
    if (!openNoteRef) return;
    const { rec, ta } = openNoteRef;
    openNoteRef = null;
    if (ta.isConnected) rec.note = ta.value.trim() || null;
    $$('.cbt-note').forEach((n) => n.remove());
    saveMarks();
  }

  function openNote(host, mark, rec) {
    commitOpenNote();
    if (!rec) return;
    const r = mark.getBoundingClientRect();
    const ta = el('textarea', { placeholder: '寫下你的想法…' }, rec.note || '');
    const box = el('div', {
      class: 'cbt-note',
      style: { left: `${Math.min(r.left, innerWidth - 280)}px`, top: `${Math.min(r.bottom + 6, innerHeight - 170)}px` },
    },
      ta,
      el('div', { class: 'acts' },
        el('button', {
          onclick: () => { openNoteRef = null; rec.note = null; box.remove(); renderExam(true); saveMarks(); },
        }, '刪除註記'),
        el('button', {
          onclick: () => { openNoteRef = null; rec.note = ta.value.trim() || null; box.remove(); renderExam(true); saveMarks(); },
        }, '儲存')));
    (document.querySelector('.cbt') || document.body).append(box);
    openNoteRef = { rec, ta };
    ta.focus();
    box.addEventListener('click', (e) => e.stopPropagation());
  }

  /** 目前這一科總共有幾筆註記（顯示在工具列，免得學生忘記自己寫過） */
  function refreshNoteCount() {
    const n = Object.entries(S.marks)
      .filter(([k]) => k.startsWith(`${S.module}:`))
      .reduce((sum, [, list]) => sum + list.filter((r) => r.note).length, 0);
    const badge = $('#note-count');
    if (badge) {
      /* 用 visibility 不用 display。徽章從無到有的時候，整排工具按鈕會
         左移約一顆按鈕的寬度 —— 學生憑記憶按 Settings 會按到 Help。 */
      badge.textContent = n ? `📝 ${n}` : '📝';
      badge.style.visibility = n ? '' : 'hidden';
      badge.style.pointerEvents = n ? '' : 'none';
      badge.style.display = '';
    }
  }

  /** 列出這一科所有註記，可以直接跳過去 */
  function showAllNotes() {
    const rows = [];
    for (const [key, list] of Object.entries(S.marks)) {
      const [mod, si] = key.split(':');
      if (mod !== S.module) continue;
      for (const rec of list) {
        if (rec.note) rows.push({ si: Number(si), rec });
      }
    }
    UI.modal({
      title: '我的註記',
      width: '560px',
      body: rows.length
        ? el('div', {}, rows.map(({ si, rec }) => el('div', {
            style: { padding: '.5rem 0', borderBottom: '1px solid var(--c-line-soft, #ddd)', cursor: 'pointer' },
            onclick: () => {
              $$('.modal-back').forEach((b) => b.remove());
              if (S.section !== si) { S.section = si; renderExam(); }
              setTimeout(() => $(`mark.hl[data-hid="${rec.hid}"]`)?.scrollIntoView({ block: 'center' }), 80);
            },
          },
            el('div', { class: 'small muted' },
              `${S.module === 'reading' ? 'Passage' : 'Part'} ${si + 1}`),
            el('div', { style: { whiteSpace: 'pre-wrap' } }, rec.note))))
        : el('p', { class: 'muted' }, '這一科還沒有任何註記。選取文字後按滑鼠右鍵就可以加。'),
      actions: [{ label: '關閉', value: true }],
    });
  }

  // ── 寫作 ────────────────────────────────────────────────
  function writingStage() {
    const mod = moduleOf('writing');
    const tasks = [];
    mod.sections.forEach((sec) => sec.groups.forEach((g) => {
      if (g.type !== 'writing_task') return;
      g.questions.forEach((q) => tasks.push({
        taskNo: q.taskNo || q.number || tasks.length + 1,
        prompt: q.prompt || q.text || '',
        image: q.image || g.image || null,
        visualDescription: q.visualDescription || '',
        minWords: q.minWords || ((q.taskNo || q.number) === 2 ? 250 : 150),
      }));
    }));
    tasks.sort((a, b) => a.taskNo - b.taskNo);
    S.writingTasks = tasks;
    const t = tasks[S.section] || tasks[0];
    if (!t) return el('div', { class: 'cbt-stage' }, el('div', { class: 'cbt-pane single' }, '這份試卷沒有寫作題。'));

    const wc = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
    const ta = el('textarea', {
      spellcheck: 'false', placeholder: 'Type your answer here…',
      oninput: (e) => {
        S.writing[t.taskNo] = e.target.value;
        S.writingDirty[t.taskNo] = e.target.value;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flush, 1200);
        const n = wc(e.target.value);
        const c = $('#wc');
        if (c) { c.textContent = String(n); c.parentElement.classList.toggle('under', n < t.minWords); }
      },
    }, S.writing[t.taskNo] ?? '');

    /* 左欄要給 id，setupSplit 才抓得到 —— 以前寫作這裡放了一根 .cbt-split
       卻沒有 id，看起來可以拖，實際上完全拖不動。Task 1 的圖表本來就需要
       更多寬度，這件事影響很大。 */
    return el('div', { class: 'cbt-stage' },
      el('div', { class: 'cbt-pane left', id: 'pane-passage' },
        el('div', { class: 'cbt-rubric' },
          el('span', { class: 'rng' }, `WRITING TASK ${t.taskNo}`),
          `You should spend about ${t.taskNo === 2 ? 40 : 20} minutes on this task. Write at least ${t.minWords} words.`),
        t.image && figure(t.image, `Task ${t.taskNo} 圖表`),
        t.visualDescription && el('div', { class: 'cbt-rubric' },
          el('span', { class: 'rng' }, '圖表說明 Figure description'), t.visualDescription),
        el('div', { class: 'cbt-body', html: sanitize(t.prompt) })),
      el('div', { class: 'cbt-split', id: 'splitter' }),
      el('div', { class: 'cbt-pane right cbt-write' },
        ta,
        el('div', { class: 'cbt-wc' + (wc(S.writing[t.taskNo]) < t.minWords ? ' under' : '') },
          el('span', {}, 'Words: ', el('b', { id: 'wc' }, String(wc(S.writing[t.taskNo])))),
          el('span', { style: { opacity: '.7' } }, `（最少 ${t.minWords} 字）`),
          el('span', { style: { flex: 1 } }),
          /* 以前這裡是寫死的「自動儲存中」，存不出去也照樣這樣寫。
             學生看到的訊號從頭到尾都是「有在存」。 */
          el('span', { id: 'save-state', style: { opacity: '.7' } }, '已自動儲存'))));
  }

  // ── 題組渲染 ────────────────────────────────────────────
  function renderGroup(module, g, si, gi) {
    if (['writing_task', 'speaking_part'].includes(g.type)) return null;
    const nums = g.questions.map((q) => q.number).filter(Boolean);
    const range = nums.length
      ? (nums.length === 1 ? `Question ${nums[0]}` : `Questions ${Math.min(...nums)}–${Math.max(...nums)}`)
      : '';

    const wrap = el('div', { class: 'cbt-group', id: `g-${si}-${gi}` },
      el('div', { class: 'cbt-rubric' },
        range && el('span', { class: 'rng' }, range),
        el('span', { html: sanitize(g.instructions || '') })),
      g.image && figure(g.image, '本題圖片'));

    if (['matching', 'gap_fill_bank', 'label_image'].includes(g.type) && g.options?.length) {
      wrap.append(optionBank(g));
    }

    /* bodyHtml 只有在**真的有 [[n]] 空格**的時候才算「題目的版面」。
       以前是 `if (g.bodyHtml)` 一律採用 —— 而驗證那邊只對
       gap_fill / gap_fill_bank 檢查空格對不對得上。於是一個 short_answer
       或 mcq_single 題組只要身上帶著一段殘留的 bodyHtml（換題型、匯入、
       AI 出題、題庫沿用都會發生），整組題目就完全不會畫出來 ——
       底部題號列照樣列出 3–7，作答區卻空空如也。實測 7 題吞掉 5 題。 */
    const gaps = gapsInHtml(g.bodyHtml);
    if (gaps.length) {
      wrap.append(renderBody(module, g));
      /* 空格沒有涵蓋到的題目仍然要畫出來。少畫一題 = 學生整題 0 分，
         而且畫面上完全看不出來。寧可重複也不能吞掉。 */
      const left = g.questions.filter((q) => !gaps.includes(Number(q.number)));
      if (left.length) wrap.append(renderPlain(module, { ...g, questions: left }));
    } else {
      if (g.bodyHtml) wrap.append(el('div', { class: 'cbt-body', html: sanitize(g.bodyHtml) }));
      wrap.append(renderPlain(module, g));
    }
    return wrap;
  }

  /** 依題型把每一題畫出來（不走 bodyHtml 那條路） */
  function renderPlain(module, g) {
    const wrap = el('div', {});
    {
      switch (g.type) {
        // 選項不見了就退回文字輸入框，至少讓學生寫得下去，不要整題卡死
        case 'mcq_multi':
          wrap.append(g.options?.length
            ? mcqMulti(module, g)
            : broken(module, g, '這一題的選項沒有載入'));
          break;
        case 'mcq_single':
          g.questions.forEach((q) => wrap.append((q.options?.length || g.options?.length)
            ? mcq(module, g, q)
            : broken(module, g, '這一題的選項沒有載入', q)));
          break;
        case 'tfng':
        case 'ynng': g.questions.forEach((q) => wrap.append(enumQ(module, g, q))); break;
        case 'matching':
        case 'gap_fill_bank':
        case 'label_image':
          g.questions.forEach((q) => wrap.append(
            (q.options?.length || g.options?.length) ? matchQ(module, g, q) : textQ(module, g, q)));
          break;
        default: g.questions.forEach((q) => wrap.append(textQ(module, g, q)));
      }
    }
    return wrap;
  }

  /** bodyHtml 裡的 [[n]] 空格（跟後端 paper.js 的 gapsIn 同一套規則） */
  function gapsInHtml(html) {
    const out = [];
    if (!html) return out;
    const re = /\[\[\s*(\d+)\s*\]\]/g;
    let m;
    while ((m = re.exec(String(html)))) out.push(Number(m[1]));
    return out;
  }

  /** 題目本身壞掉（缺選項…）時的保底：還是給得出作答框，並且講清楚 */
  function broken(module, g, why, only) {
    const qs = only ? [only] : g.questions;
    return el('div', {},
      el('div', { class: 'cbt-rubric', style: { color: '#b45309' } },
        `⚠ ${why}，請舉手告訴監考老師。你仍然可以直接把答案打在下面的空格。`),
      qs.map((q) => textQ(module, g, q)));
  }

  const optionBank = (g) => el('div', { class: 'cbt-bank' },
    el('div', { class: 't' }, g.optionsTitle || 'List of options'),
    el('ul', {}, g.options.map((o) => el('li', {}, el('b', {}, o.key), el('span', { html: sanitize(o.text) })))));

  function qShell(module, q, ...body) {
    return el('div', {
      class: 'cbt-q' + (S.current === q.number ? ' active' : ''),
      id: `q-${q.number}`, dataset: { n: q.number },
      onclick: () => { if (S.current !== q.number) { S.current = q.number; refreshFoot(); markActive(); } },
    },
      el('div', { class: 'cbt-qn' }, String(q.number)),
      el('div', { class: 'body' }, ...body));
  }

  function markActive() {
    $$('.cbt-q').forEach((n) => n.classList.toggle('active', Number(n.dataset.n) === S.current));
    $$('.cbt-gapwrap').forEach((n) => n.classList.toggle('active', n.id === `q-${S.current}`));
  }

  /**
   * 就地把一組選項的選取狀態畫出來。
   *
   * 以前是點一下選項就 renderExam(true) 把整科重畫一次。整份 DOM 被
   * replaceChildren 換掉，捲動位置跟著歸零 —— 學生選一題，畫面就跳回最上面，
   * 要再捲回去找下一題。閱讀那種要捲一千多像素的頁面尤其明顯。
   * 選一個答案只需要換兩個 class，沒有理由重建整個畫面。
   */
  function paintOptions(scope, isSelected) {
    scope.querySelectorAll('.cbt-opt').forEach((lab) => {
      const on = isSelected(lab.dataset.k);
      lab.classList.toggle('sel', on);
      const input = lab.querySelector('input');
      if (input) input.checked = on;
    });
  }

  function mcq(module, g, q) {
    const cur = S.answers[module]?.[q.number] ?? '';
    const options = q.options?.length ? q.options : (g.options || []);
    return qShell(module, q,
      q.text && el('div', { class: 'cbt-stem', html: sanitize(q.text) }),
      el('div', { class: 'cbt-opts' }, options.map((o) =>
        el('label', {
          class: 'cbt-opt' + (cur === o.key ? ' sel' : ''),
          dataset: { k: o.key },
          onclick: (e) => {
            setAnswer(module, q.number, o.key);
            paintOptions(e.currentTarget.parentElement, (k) => k === o.key);
            markActive();
          },
        },
          el('input', { type: 'radio', name: `q${q.number}`, checked: cur === o.key, readonly: true }),
          el('span', { class: 'k' }, o.key),
          el('span', { html: sanitize(o.text) })))));
  }

  function mcqMulti(module, g) {
    const nums = g.questions.map((q) => q.number);
    const pick = g.selectCount || nums.length;
    const cur = (S.answers[module]?.[nums[0]] || '').split(/[,\s]+/).filter(Boolean);
    const first = g.questions[0];

    // 選取狀態存在這裡，不再靠重畫整頁把它讀回來
    let picked = [...cur];
    const update = (key, on) => {
      const next = on ? [...new Set([...picked, key])] : picked.filter((k) => k !== key);
      if (next.length > pick) { toast(`最多只能選 ${pick} 個`, 'err'); return; }
      next.sort();
      picked = next;
      const joined = next.join(',');
      nums.forEach((n, i) => { S.answers[module][n] = i < next.length ? joined : ''; queue(module, n); });
      S.current = nums[0];
      refreshFoot();
      // 就地更新，不要 renderExam —— 那會把整科重畫，捲動位置歸零
      const box = wrap.querySelector('.cbt-opts');
      if (box) paintOptions(box, (k) => next.includes(k));
      const counter = wrap.querySelector('.cbt-multi-count');
      if (counter) counter.textContent = `Choose ${pick} — 已選 ${next.length}/${pick}`;
      markActive();
    };

    const wrap = el('div', { class: 'cbt-q' + (nums.includes(S.current) ? ' active' : ''), id: `q-${nums[0]}`, dataset: { n: nums[0] } },
      el('div', { class: 'cbt-qn' }, `${nums[0]}${nums.length > 1 ? `–${nums[nums.length - 1]}` : ''}`),
      el('div', { class: 'body' },
        first.text && el('div', { class: 'cbt-stem', html: sanitize(first.text) }),
        el('div', { class: 'small cbt-multi-count', style: { opacity: '.7', marginBottom: '.25rem' } },
          `Choose ${pick} — 已選 ${cur.length}/${pick}`),
        el('div', { class: 'cbt-opts' }, (g.options || []).map((o) =>
          el('label', {
            class: 'cbt-opt' + (cur.includes(o.key) ? ' sel' : ''),
            dataset: { k: o.key },
            onclick: (e) => { e.preventDefault(); update(o.key, !picked.includes(o.key)); },
          },
            el('input', { type: 'checkbox', checked: cur.includes(o.key), readonly: true }),
            el('span', { class: 'k' }, o.key),
            el('span', { html: sanitize(o.text) }))))));
    return wrap;
  }

  function enumQ(module, g, q) {
    const values = g.type === 'tfng' ? ['TRUE', 'FALSE', 'NOT GIVEN'] : ['YES', 'NO', 'NOT GIVEN'];
    const cur = S.answers[module]?.[q.number] ?? '';
    return qShell(module, q,
      q.text && el('div', { class: 'cbt-stem', html: sanitize(q.text) }),
      el('div', { class: 'cbt-opts inline' }, values.map((v) =>
        el('label', {
          class: 'cbt-opt' + (cur === v ? ' sel' : ''),
          dataset: { k: v },
          onclick: (e) => {
            setAnswer(module, q.number, v);
            paintOptions(e.currentTarget.parentElement, (k) => k === v);
            markActive();
          },
        },
          el('input', { type: 'radio', name: `q${q.number}`, checked: cur === v, readonly: true }),
          el('span', {}, v)))));
  }

  function matchQ(module, g, q) {
    const cur = S.answers[module]?.[q.number] ?? '';
    const options = q.options?.length ? q.options : (g.options || []);
    return qShell(module, q,
      el('div', { style: { display: 'flex', gap: '.6rem', alignItems: 'flex-start' } },
        el('select', {
          class: 'cbt-sel',
          onchange: (e) => setAnswer(module, q.number, e.target.value),
          onfocus: () => { S.current = q.number; refreshFoot(); markActive(); },
        },
          el('option', { value: '' }, '—'),
          options.map((o) => el('option', { value: o.key, selected: cur === o.key }, o.key))),
        q.text && el('div', { class: 'cbt-stem', style: { flex: 1 }, html: sanitize(q.text) })));
  }

  function textQ(module, g, q) {
    const cur = S.answers[module]?.[q.number] ?? '';
    return qShell(module, q,
      q.text
        ? el('div', { class: 'cbt-stem', html: sanitize(q.text) })
        : el('div', { class: 'cbt-stem', style: { color: '#b45309' } }, '⚠ 這一題的題目文字缺漏，請舉手告訴監考老師'),
      el('div', {},
        el('input', {
          type: 'text', class: 'cbt-gap' + (cur ? ' filled' : ''), value: cur,
          style: { width: '20ch' }, autocomplete: 'off', spellcheck: 'false',
          oninput: (e) => {
            S.answers[module][q.number] = e.target.value;
            e.target.classList.toggle('filled', !!e.target.value);
            queue(module, q.number); refreshFoot();
          },
          onfocus: () => { S.current = q.number; refreshFoot(); markActive(); },
        }),
        g.wordLimit ? el('span', { class: 'small', style: { marginLeft: '.5rem', opacity: '.7' } }, `最多 ${g.wordLimit} 字`) : null));
  }

  /** 有 bodyHtml 的題組：把 [[n]] 換成輸入框或下拉選單 */
  function renderBody(module, g) {
    const host = el('div', { class: 'cbt-body' });
    host.innerHTML = sanitize(g.bodyHtml);
    const byNum = new Map(g.questions.map((q) => [Number(q.number), q]));

    const walk = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE && /\[\[\s*\d+\s*\]\]/.test(child.nodeValue)) {
          const frag = document.createDocumentFragment();
          for (const part of child.nodeValue.split(/(\[\[\s*\d+\s*\]\])/)) {
            const m = part.match(/^\[\[\s*(\d+)\s*\]\]$/);
            if (!m) { frag.append(document.createTextNode(part)); continue; }
            const n = Number(m[1]);
            frag.append(gapControl(module, g, n, byNum.get(n)));
          }
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
      }
    };
    walk(host);
    return host;
  }

  function gapControl(module, g, n, q) {
    const cur = S.answers[module]?.[n] ?? '';
    const options = q?.options || g.options;
    const wrap = el('span', {
      class: 'cbt-gapwrap' + (S.current === n ? ' active' : ''), id: `q-${n}`,
    }, el('span', { class: 'n' }, String(n)));

    if (['gap_fill_bank', 'matching'].includes(g.type) && options?.length) {
      wrap.append(el('select', {
        class: 'cbt-sel',
        onchange: (e) => setAnswer(module, n, e.target.value),
        onfocus: () => { S.current = n; refreshFoot(); markActive(); },
      },
        el('option', { value: '' }, '—'),
        options.map((o) => el('option', { value: o.key, selected: cur === o.key }, o.key))));
    } else {
      wrap.append(el('input', {
        type: 'text', class: 'cbt-gap' + (cur ? ' filled' : ''), value: cur,
        autocomplete: 'off', spellcheck: 'false',
        oninput: (e) => {
          S.answers[module][n] = e.target.value;
          e.target.classList.toggle('filled', !!e.target.value);
          queue(module, n); refreshFoot();
        },
        onfocus: () => { S.current = n; refreshFoot(); markActive(); },
      }));
    }
    return wrap;
  }

  // ── 底部列 ──────────────────────────────────────────────
  function footBar() {
    const name = S.module;

    if (name === 'writing') {
      return el('div', { class: 'cbt-foot' },
        el('div', { class: 'cbt-parts' }, (S.writingTasks || []).map((t, i) =>
          el('div', { class: 'cbt-part' + (i === S.section ? '' : ' collapsed') },
            el('span', { class: 'lbl', onclick: () => { S.section = i; renderExam(); } }, `Task ${t.taskNo}`),
            el('button', {
              class: 'cbt-num' + ((S.writing[t.taskNo] || '').trim() ? ' answered' : '') + (i === S.section ? ' current' : ''),
              onclick: () => { S.section = i; renderExam(); },
            }, String(t.taskNo))))),
        el('div', { class: 'cbt-arrows' },
          el('button', { class: 'cbt-btn', onclick: () => finishModule(false) }, '結束寫作')));
    }
    /* 存檔狀態要三科都看得到，不能只有寫作有。
       閱讀與聽力的「已作答」深色標記是從記憶體算的 —— 存不出去的時候
       畫面看起來一模一樣，學生要等成績出來才會發現整段是空的。 */

    const mod = moduleOf(name);
    const parts = el('div', { class: 'cbt-parts', id: 'cbt-parts' });

    mod.sections.forEach((sec, si) => {
      const qs = flat(name).filter((q) => q.si === si);
      if (!qs.length) return;
      const expanded = si === S.section;
      const answered = qs.filter((q) => String(S.answers[name]?.[q.number] ?? '').trim()).length;
      const label = name === 'reading' ? `Passage ${si + 1}` : `Part ${si + 1}`;

      parts.append(el('div', { class: 'cbt-part' + (expanded ? '' : ' collapsed') },
        el('span', {
          class: 'lbl',
          title: `${answered}/${qs.length} 題已作答`,
          onclick: () => { S.section = si; S.current = qs[0].number; renderExam(); },
        }, expanded ? label : `${label} (${answered}/${qs.length})`),
        expanded
          ? qs.map((q) => el('button', {
              class: 'cbt-num', dataset: { n: q.number },
              onclick: () => goto(si, q.number),
            }, String(q.number)))
          : null));
    });

    return el('div', { class: 'cbt-foot' },
      el('label', { class: 'cbt-review' },
        el('input', {
          type: 'checkbox', id: 'rev-box',
          onchange: () => { if (S.current != null) toggleReview(S.current); },
        }),
        el('span', {}, 'Review')),
      parts,
      el('div', { class: 'cbt-arrows' },
        el('span', { id: 'save-state', class: 'small', style: { opacity: '.7', marginRight: '.4rem' } }, '已自動儲存'),
        el('button', { title: '上一題', onclick: () => step(-1) }, '◀'),
        el('button', { title: '下一題', onclick: () => step(1) }, '▶'),
        el('button', { class: 'cbt-btn', onclick: () => finishModule(false) }, '結束這一科')));
  }

  function refreshFoot() {
    const name = S.module;
    if (!name || name === 'writing') return;
    $$('#cbt-parts .cbt-num').forEach((b) => {
      const n = Number(b.dataset.n);
      const v = S.answers[name]?.[n];
      b.classList.toggle('answered', !!(v && String(v).trim()));
      b.classList.toggle('review', S.review[name]?.has(n));
      b.classList.toggle('current', S.current === n);
    });
    const box = $('#rev-box');
    if (box) box.checked = S.current != null && !!S.review[name]?.has(Number(S.current));
  }

  function goto(si, n) {
    if (S.section !== si) { S.section = si; S.current = n; renderExam(); }
    S.current = n;
    setTimeout(() => {
      const t = document.getElementById(`q-${n}`);
      if (t) {
        t.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const inp = t.querySelector('input[type=text],select');
        if (inp) inp.focus({ preventScroll: true });
      }
      markActive();
      refreshFoot();
    }, 30);
  }

  function step(dir) {
    const qs = flat(S.module);
    if (!qs.length) return;
    const i = qs.findIndex((q) => q.number === S.current);
    const next = qs[Math.min(qs.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
    if (next) goto(next.si, next.number);
  }

  // 官方也支援鍵盤操作
  document.addEventListener('keydown', (e) => {
    if (!S || !S.module || S.module === 'writing') return;
    if (e.target.matches('input,textarea,select')) return;
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });

  /**
   * 離開頁面時的最後一次儲存。
   *
   * 以前用的是一般的 fetch —— 使用者按下「離開」之後瀏覽器會直接中止
   * 進行中的請求，等於沒存。而且只掛了 beforeunload：平板／手機把分頁
   * 回收、筆電闔上、瀏覽器當掉，這個事件根本不會觸發，最後 900 毫秒內
   * 的作答就直接消失，學生重進來只會發現最後幾題回到空白。
   *
   * sendBeacon 是瀏覽器保證會送出去的通道（頁面關掉也照送）。
   */
  function beacon() {
    if (!S?.attemptId || !S.module) return;
    const items = [...pending.values()];
    const essays = Object.entries(S.writingDirty || {});
    if (!items.length && !essays.length) return;
    const send = (path, body) => {
      const blob = new Blob([JSON.stringify({ ...body, token: API.token })], { type: 'application/json' });
      if (!navigator.sendBeacon?.(`/api/exam/${S.attemptId}${path}`, blob)) {
        // 沒有 sendBeacon 的老瀏覽器：keepalive 至少不會被中止
        fetch(`/api/exam/${S.attemptId}${path}`, {
          method: 'POST', keepalive: true,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${API.token}` },
          body: JSON.stringify(body),
        }).catch(() => {});
      }
    };
    if (items.length) send('/answers', { items });
    essays.forEach(([taskNo, essay]) => send('/writing', { taskNo: Number(taskNo), essay }));
  }
  window.addEventListener('beforeunload', (e) => {
    if (S && S.module) { beacon(); e.preventDefault(); e.returnValue = ''; }
  });
  // pagehide 才是分頁被系統回收、切到背景後被殺掉時真正會觸發的那一個
  window.addEventListener('pagehide', beacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') beacon();
  });

  return { open, dlg, notice, prefs, applyPrefs, zoom: lightbox };
})();
