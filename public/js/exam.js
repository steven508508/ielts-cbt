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
  let pending = new Map();
  let saveTimer = null;

  // ── 個人化設定（跨場次記住）────────────────────────────
  const PREF_KEY = 'ielts_cbt_prefs';
  const prefs = Object.assign({ size: 'standard', scheme: 'standard' }, (() => {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; }
  })());
  const savePrefs = () => localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  function applyPrefs() {
    const c = $('.cbt');
    if (!c) return;
    c.dataset.size = prefs.size;
    c.dataset.scheme = prefs.scheme;
  }

  // ── 官方風格對話框 ──────────────────────────────────────
  function dlg({ title, body, actions = [], dismissable = false }) {
    return new Promise((resolve) => {
      const dim = el('div', { class: 'cbt-dim' });
      const close = (v) => { dim.remove(); resolve(v); };
      dim.append(el('div', { class: 'cbt-dialog' },
        el('h3', {}, title),
        el('div', { class: 'bd' }, body),
        actions.length && el('div', { class: 'ft' }, actions.map((a) =>
          el('button', {
            class: `cbt-btn ${a.primary ? 'primary' : ''}`,
            onclick: () => { if (a.onClick && a.onClick(dim) === false) return; close(a.value); },
          }, a.label)))));
      if (dismissable) dim.addEventListener('click', (e) => { if (e.target === dim) close(null); });
      (document.querySelector('.cbt') || document.body).append(dim);
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
      warned: {}, notes: (data.state?.notes || []),
      counts: data.counts, savedSpeaking: data.saved.speaking || [],
      timerHidden: false,
    };
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
    const count = r.leaveCount ?? S.leaveCount;

    // 超過上限的處置
    if (p.maxLeaves > 0 && count >= p.maxLeaves && p.onExceed === 'submit') {
      await reportEvent('auto_submit', `離開 ${count} 次，超過上限 ${p.maxLeaves}`);
      await notice('已自動結束這一科', el('div', {},
        el('p', {}, `你離開考試畫面 ${count} 次，已超過老師設定的上限（${p.maxLeaves} 次）。`),
        el('p', {}, '這一科已自動收卷，紀錄會提供給老師。')));
      return finishModule(true);
    }

    if (!p.warnOnLeave || violationOpen) return;
    violationOpen = true;
    const over = p.maxLeaves > 0 ? `（第 ${count} 次，上限 ${p.maxLeaves} 次）` : `（第 ${count} 次）`;
    await notice('考試紀律提醒', el('div', {},
      el('p', {}, el('b', {}, `偵測到你${label}${over}`)),
      el('p', {}, '考試進行中請勿切換分頁、視窗或離開全螢幕，這些行為都會被記錄下來給老師。'),
      p.maxLeaves > 0 && p.onExceed === 'submit'
        ? el('p', { style: { color: '#c0392b' } }, `再離開 ${Math.max(0, p.maxLeaves - count)} 次，這一科就會自動收卷。`)
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

    document.addEventListener('visibilitychange', () => {
      if (!S || !S.module) return;
      if (document.visibilityState === 'hidden') onViolation('leave', '切換到其他分頁或視窗');
      else reportEvent('return');
    });

    window.addEventListener('blur', () => {
      if (!S || !S.module || document.visibilityState === 'hidden') return;
      // 只有真的切走才算，點擊 iframe 之類的忽略
      setTimeout(() => {
        if (document.hasFocus() || !S.module) return;
        onViolation('leave', '離開考試視窗');
      }, 400);
    });

    document.addEventListener('fullscreenchange', () => {
      if (!S || !S.module || !proc().enabled || !proc().requireFullscreen) return;
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
      el('p', {}, el('b', {}, '螢光筆與註記：'), '選取文字後按滑鼠右鍵，可以選擇 Highlight（畫線）或 Notes（加註記）。'),
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
    S.module = name;
    S.section = 0;
    S.current = null;
    S.warned = {};

    if (name === 'speaking') {
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
  function startTimer(endsAt) {
    stopTimer();
    S.endsAt = endsAt;
    const upd = () => {
      const leftSec = Math.max(0, (S.endsAt - Date.now()) / 1000);
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
      if (leftSec <= 0) { stopTimer(); finishModule(true); }
    };
    upd();
    tick = setInterval(upd, 500);
  }
  function stopTimer() { if (tick) clearInterval(tick); tick = null; }

  async function finishModule(auto = false) {
    if (!auto) {
      const ok = await ask('結束這一科',
        el('p', {}, `確定要結束「${UI.MODULE_LABEL[S.module]}」嗎？結束後就不能再修改答案。`), '結束');
      if (!ok) return;
    }
    await flush();
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
            : el('p', {}, '你的作文已儲存。'),
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

  async function flush() {
    clearTimeout(saveTimer);
    const items = [...pending.values()];
    pending.clear();
    const jobs = [];
    if (items.length) {
      jobs.push(API.post(`/exam/${S.attemptId}/answers`, { items })
        .catch(() => toast('答案儲存失敗，請檢查網路連線', 'err')));
    }
    for (const [taskNo, essay] of Object.entries(S.writingDirty || {})) {
      jobs.push(API.post(`/exam/${S.attemptId}/writing`, { taskNo: Number(taskNo), essay }).catch(() => {}));
    }
    S.writingDirty = {};
    await Promise.all(jobs);
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
    const scroll = keepScroll ? ($('.cbt-pane.right')?.scrollTop ?? $('.cbt-pane.single')?.scrollTop ?? 0) : 0;
    const name = S.module;
    const mod = moduleOf(name);
    const sec = mod.sections[S.section] || mod.sections[0];

    const stage = name === 'writing' ? writingStage()
      : name === 'reading' ? readingStage(sec)
      : listeningStage(sec);

    shell(topBar(), bandBar(name, sec), stage, footBar());

    if (keepScroll) {
      const p = $('.cbt-pane.right') || $('.cbt-pane.single');
      if (p) p.scrollTop = scroll;
    }
    refreshFoot();
    if (name === 'reading') { setupSplit(); setupContextMenu(); }
    if (name === 'listening') setupAudio();
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
          sec.groups.map((g, gi) => renderGroup('listening', g, S.section, gi)))));
  }

  function audioBar(sec) {
    if (!sec.audio) return el('div', { class: 'cbt-audio' }, el('span', { class: 'st' }, '（本 Part 沒有音檔）'));
    return el('div', { class: 'cbt-audio' },
      el('span', { class: 'st', id: 'aud-st' }, '準備播放'),
      el('div', { class: 'bar' }, el('i', { id: 'aud-pg' })),
      el('span', {}, '🔊'),
      el('input', {
        type: 'range', min: 0, max: 1, step: 0.05, value: 1, id: 'aud-vol',
        oninput: (e) => { const a = $('#aud-el'); if (a) a.volume = Number(e.target.value); },
      }),
      el('audio', { id: 'aud-el', src: sec.audio, preload: 'auto', style: { display: 'none' } }));
  }

  function setupAudio() {
    const a = $('#aud-el');
    if (!a) return;
    const st = $('#aud-st');
    const pg = $('#aud-pg');
    const audioState = (S.state.audio = S.state.audio || {});
    const key = `s${S.section}`;

    a.addEventListener('timeupdate', () => {
      if (a.duration) pg.style.width = `${(a.currentTime / a.duration) * 100}%`;
      audioState[key] = a.currentTime;
    });
    a.addEventListener('error', () => { st.textContent = '音檔載入失敗，請通知老師'; });
    a.addEventListener('ended', () => {
      st.textContent = '本 Part 音檔已播畢';
      const mod = moduleOf('listening');
      if (S.section < mod.sections.length - 1) {
        setTimeout(() => { S.section += 1; S.current = flat('listening').find((q) => q.si === S.section)?.number ?? S.current; renderExam(); }, 1500);
      }
    });
    // 官方規則：只播一次、不能倒轉
    a.addEventListener('seeking', () => {
      if (a.currentTime < (audioState[key] || 0) - 0.6) a.currentTime = audioState[key] || 0;
    });

    if (audioState[`${key}_played`]) { st.textContent = '本 Part 音檔已播過（只播放一次）'; return; }
    st.textContent = '播放中…';
    audioState[`${key}_played`] = true;
    a.play().catch(() => {
      st.textContent = '請點畫面任一處開始播放';
      const go = () => { a.play(); st.textContent = '播放中…'; };
      document.addEventListener('click', go, { once: true });
    });
  }

  // ── 閱讀 ────────────────────────────────────────────────
  function readingStage(sec) {
    return el('div', { class: 'cbt-stage' },
      el('div', { class: 'cbt-pane left cbt-passage', id: 'pane-passage' },
        el('h2', {}, sec.passageTitle || sec.title),
        sec.source && el('div', { class: 'sub' }, sec.source),
        el('div', { html: sanitize(sec.passage || '<p>（沒有文章內容）</p>') })),
      el('div', { class: 'cbt-split', id: 'splitter' }),
      el('div', { class: 'cbt-pane right' },
        sec.groups.map((g, gi) => renderGroup('reading', g, S.section, gi))));
  }

  function setupSplit() {
    const sp = $('#splitter');
    const left = $('#pane-passage');
    if (!sp || !left) return;
    let dragging = false;
    const move = (x) => {
      const pct = Math.min(78, Math.max(22, (x / window.innerWidth) * 100));
      left.style.flex = `0 0 ${pct}%`;
    };
    sp.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); document.body.style.cursor = 'col-resize'; });
    window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
    window.addEventListener('mousemove', (e) => { if (dragging) move(e.clientX); });
    sp.addEventListener('touchmove', (e) => { move(e.touches[0].clientX); }, { passive: true });
  }

  // ── 右鍵：螢光筆 / 註記 ─────────────────────────────────
  let menuEl = null;
  function closeMenu() { menuEl?.remove(); menuEl = null; }

  function setupContextMenu() {
    const targets = ['#pane-passage', '.cbt-pane.right'];
    for (const sel of targets) {
      const host = $(sel);
      if (!host) continue;
      host.addEventListener('contextmenu', (e) => {
        const mark = e.target.closest('mark.hl');
        const sel2 = window.getSelection();
        const hasSel = sel2 && !sel2.isCollapsed && host.contains(sel2.anchorNode);
        if (!mark && !hasSel) return;      // 沒選字也沒點到畫線 → 用瀏覽器原生選單
        e.preventDefault();
        openMenu(e.clientX, e.clientY, { mark, host });
      });
    }
    document.addEventListener('click', closeMenu, { once: false });
    document.addEventListener('scroll', closeMenu, true);
  }

  function openMenu(x, y, { mark, host }) {
    closeMenu();
    const items = [];
    if (!mark) {
      items.push(['🖍 Highlight　畫線', () => wrapSelection(false)]);
      items.push(['📝 Notes　加註記', () => wrapSelection(true)]);
    } else {
      if (mark.dataset.note) items.push(['📝 編輯註記', () => openNote(mark)]);
      else items.push(['📝 加註記', () => { mark.classList.add('has-note'); openNote(mark); }]);
      items.push(['✖ 清除這一段', () => { mark.replaceWith(...mark.childNodes); persistNotes(); }]);
    }
    items.push(['🧽 清除全部畫線', () => {
      $$('mark.hl', host).forEach((m) => m.replaceWith(...m.childNodes));
      persistNotes();
    }]);

    menuEl = el('div', { class: 'cbt-menu', style: { left: `${x}px`, top: `${y}px` } },
      items.map(([label, fn], i) => [
        i === items.length - 1 ? el('hr') : null,
        el('button', { onclick: (e) => { e.stopPropagation(); closeMenu(); fn(); } }, label),
      ]));
    (document.querySelector('.cbt') || document.body).append(menuEl);

    const r = menuEl.getBoundingClientRect();
    if (r.right > innerWidth) menuEl.style.left = `${innerWidth - r.width - 8}px`;
    if (r.bottom > innerHeight) menuEl.style.top = `${innerHeight - r.height - 8}px`;
  }

  function wrapSelection(withNote) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    try {
      const range = sel.getRangeAt(0);
      const mark = document.createElement('mark');
      mark.className = 'hl' + (withNote ? ' has-note' : '');
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
      sel.removeAllRanges();
      mark.addEventListener('click', () => { if (mark.dataset.note) openNote(mark); });
      if (withNote) openNote(mark);
      persistNotes();
    } catch {
      toast('這段文字沒辦法畫線，請選取同一個段落內的文字', 'err');
    }
  }

  function openNote(mark) {
    $$('.cbt-note').forEach((n) => n.remove());
    const r = mark.getBoundingClientRect();
    const ta = el('textarea', { placeholder: '寫下你的想法…' }, mark.dataset.note || '');
    const box = el('div', {
      class: 'cbt-note',
      style: { left: `${Math.min(r.left, innerWidth - 280)}px`, top: `${Math.min(r.bottom + 6, innerHeight - 170)}px` },
    },
      ta,
      el('div', { class: 'acts' },
        el('button', {
          onclick: () => { delete mark.dataset.note; mark.classList.remove('has-note'); box.remove(); persistNotes(); },
        }, '刪除'),
        el('button', {
          onclick: () => { mark.dataset.note = ta.value; mark.classList.toggle('has-note', !!ta.value); box.remove(); persistNotes(); },
        }, '儲存')));
    (document.querySelector('.cbt') || document.body).append(box);
    ta.focus();
    box.addEventListener('click', (e) => e.stopPropagation());
  }

  function persistNotes() {
    S.notes = $$('mark.hl[data-note]').map((m) => ({ text: m.textContent.slice(0, 60), note: m.dataset.note }));
    API.post(`/exam/${S.attemptId}/state`, { ui: { notes: S.notes } }).catch(() => {});
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

    return el('div', { class: 'cbt-stage' },
      el('div', { class: 'cbt-pane left' },
        el('div', { class: 'cbt-rubric' },
          el('span', { class: 'rng' }, `WRITING TASK ${t.taskNo}`),
          `You should spend about ${t.taskNo === 2 ? 40 : 20} minutes on this task. Write at least ${t.minWords} words.`),
        t.image && el('img', {
          class: 'fig', src: t.image, alt: `Task ${t.taskNo}`,
          onerror: (e) => { e.target.style.display = 'none'; },
        }),
        t.visualDescription && el('div', { class: 'cbt-rubric' },
          el('span', { class: 'rng' }, '圖表說明 Figure description'), t.visualDescription),
        el('div', { class: 'cbt-body', html: sanitize(t.prompt) })),
      el('div', { class: 'cbt-split' }),
      el('div', { class: 'cbt-pane right cbt-write' },
        ta,
        el('div', { class: 'cbt-wc' + (wc(S.writing[t.taskNo]) < t.minWords ? ' under' : '') },
          el('span', {}, 'Words: ', el('b', { id: 'wc' }, String(wc(S.writing[t.taskNo])))),
          el('span', { style: { opacity: '.7' } }, `（最少 ${t.minWords} 字）`),
          el('span', { style: { flex: 1 } }),
          el('span', { style: { opacity: '.7' } }, '自動儲存中'))));
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
      g.image && el('img', { class: 'fig', src: g.image, alt: '', onerror: (e) => { e.target.style.display = 'none'; } }));

    if (['matching', 'gap_fill_bank', 'label_image'].includes(g.type) && g.options?.length) {
      wrap.append(optionBank(g));
    }

    if (g.bodyHtml) {
      wrap.append(renderBody(module, g));
    } else {
      switch (g.type) {
        case 'mcq_multi': wrap.append(mcqMulti(module, g)); break;
        case 'mcq_single': g.questions.forEach((q) => wrap.append(mcq(module, g, q))); break;
        case 'tfng':
        case 'ynng': g.questions.forEach((q) => wrap.append(enumQ(module, g, q))); break;
        case 'matching': g.questions.forEach((q) => wrap.append(matchQ(module, g, q))); break;
        case 'label_image':
          g.questions.forEach((q) => wrap.append(
            (q.options || g.options)?.length ? matchQ(module, g, q) : textQ(module, g, q)));
          break;
        default: g.questions.forEach((q) => wrap.append(textQ(module, g, q)));
      }
    }
    return wrap;
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

  function mcq(module, g, q) {
    const cur = S.answers[module]?.[q.number] ?? '';
    const options = q.options || g.options || [];
    return qShell(module, q,
      q.text && el('div', { class: 'cbt-stem', html: sanitize(q.text) }),
      el('div', { class: 'cbt-opts' }, options.map((o) =>
        el('label', {
          class: 'cbt-opt' + (cur === o.key ? ' sel' : ''),
          onclick: () => { setAnswer(module, q.number, o.key); renderExam(true); },
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

    const update = (key, on) => {
      let next = on ? [...new Set([...cur, key])] : cur.filter((k) => k !== key);
      if (next.length > pick) { toast(`最多只能選 ${pick} 個`, 'err'); return; }
      next.sort();
      const joined = next.join(',');
      nums.forEach((n, i) => { S.answers[module][n] = i < next.length ? joined : ''; queue(module, n); });
      S.current = nums[0];
      refreshFoot();
      renderExam(true);
    };

    return el('div', { class: 'cbt-q' + (nums.includes(S.current) ? ' active' : ''), id: `q-${nums[0]}`, dataset: { n: nums[0] } },
      el('div', { class: 'cbt-qn' }, `${nums[0]}${nums.length > 1 ? `–${nums[nums.length - 1]}` : ''}`),
      el('div', { class: 'body' },
        first.text && el('div', { class: 'cbt-stem', html: sanitize(first.text) }),
        el('div', { class: 'small', style: { opacity: '.7', marginBottom: '.25rem' } }, `Choose ${pick} — 已選 ${cur.length}/${pick}`),
        el('div', { class: 'cbt-opts' }, (g.options || []).map((o) =>
          el('label', {
            class: 'cbt-opt' + (cur.includes(o.key) ? ' sel' : ''),
            onclick: (e) => { e.preventDefault(); update(o.key, !cur.includes(o.key)); },
          },
            el('input', { type: 'checkbox', checked: cur.includes(o.key), readonly: true }),
            el('span', { class: 'k' }, o.key),
            el('span', { html: sanitize(o.text) }))))));
  }

  function enumQ(module, g, q) {
    const values = g.type === 'tfng' ? ['TRUE', 'FALSE', 'NOT GIVEN'] : ['YES', 'NO', 'NOT GIVEN'];
    const cur = S.answers[module]?.[q.number] ?? '';
    return qShell(module, q,
      q.text && el('div', { class: 'cbt-stem', html: sanitize(q.text) }),
      el('div', { class: 'cbt-opts inline' }, values.map((v) =>
        el('label', {
          class: 'cbt-opt' + (cur === v ? ' sel' : ''),
          onclick: () => { setAnswer(module, q.number, v); renderExam(true); },
        },
          el('input', { type: 'radio', name: `q${q.number}`, checked: cur === v, readonly: true }),
          el('span', {}, v)))));
  }

  function matchQ(module, g, q) {
    const cur = S.answers[module]?.[q.number] ?? '';
    const options = q.options || g.options || [];
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
      q.text && el('div', { class: 'cbt-stem', html: sanitize(q.text) }),
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

  window.addEventListener('beforeunload', (e) => {
    if (S && S.module) { flush(); e.preventDefault(); e.returnValue = ''; }
  });

  return { open, dlg, notice, prefs, applyPrefs };
})();
