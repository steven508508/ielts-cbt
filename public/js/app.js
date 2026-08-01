/* ═══════════════════════════════════════════════════════════
   路由與主要頁面
   ═══════════════════════════════════════════════════════════ */
(() => {
  const { el, $$, band, fmtDate, toast } = UI;
  const root = () => document.getElementById('app');

  // ── Cloudflare Turnstile ────────────────────────────────
  const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  let turnstileLoading = null;
  let activeWidget = null;   // 上一個 widget 的 id，重畫前要先拆掉

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (turnstileLoading) return turnstileLoading;
    turnstileLoading = new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      const timer = setTimeout(
        () => done(reject, new Error('載入 Cloudflare 驗證元件逾時（15 秒）')), 15000);
      const s = document.createElement('script');
      s.src = TURNSTILE_SRC;
      s.async = true; s.defer = true;
      s.onload = () => done(resolve, window.turnstile);
      s.onerror = () => done(reject, new Error('無法載入 Cloudflare 驗證元件'));
      document.head.append(s);
    }).catch((e) => { turnstileLoading = null; throw e; });   // 失敗就讓下次可以重試
    return turnstileLoading;
  }

  /** 拆掉上一個 widget。登出後重新進登入頁時一定要做，否則會殘留一堆孤兒 widget。 */
  function dropTurnstile() {
    if (activeWidget !== null && window.turnstile) {
      try { window.turnstile.remove(activeWidget); } catch { /* 已經不在了 */ }
    }
    activeWidget = null;
  }

  /** 把 Cloudflare 的錯誤代碼翻成看得懂的話 —— 對照官方 client-side error codes */
  function turnstileErrorHint(code) {
    const c = String(code || '');
    if (c.startsWith('110200')) return {
      title: '這個網域沒有被授權（代碼 110200）',
      body: `Cloudflare 那個 Widget 的「網域 / Hostname」清單裡沒有 ${location.hostname}。`,
      fix: '到 Cloudflare 儀表板 → Turnstile → 這個 Widget → Hostname Management，把上面那個網域加進去（不含 https:// 與連接埠）。',
    };
    if (c.startsWith('110100') || c.startsWith('110110') || c.startsWith('400020')) return {
      title: 'Site Key 不正確（代碼 ' + c + '）',
      body: '伺服器上填的 Site Key，Cloudflare 找不到。',
      fix: '確認「系統設定 → 人機驗證」貼的是 Site Key（0x4AAA… 開頭的公開金鑰），而不是 Secret Key，也別把兩個貼反。',
    };
    if (c.startsWith('400070')) return {
      title: 'Widget 已被停用（代碼 400070）',
      body: 'Cloudflare 上這個 Widget 目前是停用狀態。',
      fix: '到 Cloudflare 儀表板把它重新啟用，或改用另一組金鑰。',
    };
    if (c.startsWith('200500')) return {
      title: '驗證框載不進來（代碼 200500）',
      body: '這台電腦連不到 challenges.cloudflare.com——常見於學校防火牆、DNS 過濾或廣告封鎖擴充套件。',
      fix: '把 challenges.cloudflare.com 加進白名單，或請管理員關閉登入人機驗證。',
    };
    if (c.startsWith('200100')) return {
      title: '電腦時間不對（代碼 200100）',
      body: '這台電腦的時鐘和實際時間差太多，Cloudflare 無法驗證。',
      fix: '把系統時間改成自動同步後重新整理。',
    };
    if (c.startsWith('110600') || c.startsWith('110620')) return {
      title: '驗證逾時（代碼 ' + c + '）',
      body: '太久沒完成驗證。',
      fix: '按下面的「重新驗證」再試一次。',
    };
    if (c.startsWith('300') || c.startsWith('600')) return {
      title: '驗證未通過（代碼 ' + c + '）',
      body: 'Cloudflare 認為這次連線可疑，常見原因是使用 VPN／代理，或瀏覽器擴充套件干擾。',
      fix: '關掉 VPN 與廣告封鎖擴充套件，或改用無痕視窗再試。',
    };
    return {
      title: c ? `人機驗證發生錯誤（代碼 ${c}）` : '人機驗證發生錯誤',
      body: '驗證元件無法完成初始化。',
      fix: '請按「重新驗證」；若一直失敗，請管理員在伺服器上執行 node server/scripts/turnstile.js --off 暫時關閉。',
    };
  }

  function turnstileErrorBox(code, onRetry) {
    const h = turnstileErrorHint(code);
    return el('div', {
      class: 'small',
      style: {
        textAlign: 'left', lineHeight: '1.75', color: 'var(--err)',
        border: '1px solid #e6b8b3', background: '#fdf0ee',
        borderRadius: '4px', padding: '.6rem .7rem', width: '100%',
      },
    },
      el('b', {}, h.title), el('br'),
      h.body, el('br'),
      el('span', { class: 'muted' }, h.fix),
      el('div', { class: 'muted', style: { marginTop: '.4rem', fontSize: '.78rem' } },
        `目前網址：${location.protocol}//${location.host}`),
      el('div', { style: { marginTop: '.5rem', display: 'flex', gap: '.4rem' } },
        el('button', { class: 'btn sm', type: 'button', onclick: onRetry }, '重新驗證')));
  }

  // ── 登入 ────────────────────────────────────────────────
  async function loginPage() {
    document.body.classList.remove('exam-body');
    document.body.style.overflow = '';

    const u = el('input', { type: 'text', autofocus: true, autocomplete: 'username' });
    const p = el('input', { type: 'password', autocomplete: 'current-password' });
    const msg = el('div', { class: 'small', style: { color: 'var(--err)', minHeight: '1.2em', lineHeight: '1.5' } });
    const capBox = el('div', { style: { margin: '.2rem 0 .6rem', display: 'flex', justifyContent: 'center' } });
    const btn = el('button', { class: 'btn primary', type: 'submit', style: { width: '100%', marginTop: '.5rem' } }, '登入');

    let widgetId = null;
    let token = '';

    const submit = async () => {
      msg.textContent = '';
      msg.style.color = 'var(--err)';
      btn.disabled = true;
      try {
        const r = await API.post('/auth/login', {
          username: u.value.trim(), password: p.value, turnstileToken: token,
        });
        API.setSession(r.token, r.user);
        dropTurnstile();
        location.hash = '#/';
        route();
      } catch (e) {
        msg.textContent = e.message;
        // Turnstile 的 token 只能用一次，登入失敗就要重新驗證
        if (widgetId !== null && window.turnstile) {
          token = '';
          try { window.turnstile.reset(widgetId); } catch {}
        }
      } finally {
        btn.disabled = false;
      }
    };

    UI.render(root(), el('div', { class: 'login-wrap' },
      el('form', {
        class: 'login-box',
        onsubmit: (e) => { e.preventDefault(); submit(); },
      },
        el('div', { class: 'logo' }, 'IELTS 模擬考試系統'),
        el('div', { class: 'sub' }, '電腦化測驗 · 四科完整模擬 · AI 批改'),
        el('label', { class: 'field' }, el('span', {}, '帳號'), u),
        el('label', { class: 'field' }, el('span', {}, '密碼'), p),
        capBox,
        msg,
        btn,
        el('p', { class: 'small muted', style: { marginTop: '1rem', textAlign: 'center' } },
          '忘記密碼請找老師或管理員重設。'),
        el('p', { class: 'small', style: { marginTop: '.4rem', textAlign: 'center' } },
          el('a', { href: '#/check' }, '🩺 考前環境檢查'),
          el('span', { class: 'muted' }, '　不用登入，考前先確認麥克風與音量')))));

    // 有開 Turnstile 才載入元件；沒開的話登入頁完全不會碰 Cloudflare
    let cfg = null;
    try { cfg = (await API.get('/auth/config')).turnstile; } catch { cfg = null; }
    if (!cfg?.enabled || !cfg.siteKey) return;

    // 登出後會再次進到這裡，上一輪的 widget 必須先拆掉，
    // 否則 Cloudflare 內部仍記著那個已經被移除的 DOM 節點，新的驗證框就畫不出來。
    dropTurnstile();

    const retry = () => { dropTurnstile(); turnstileLoading = null; loginPage(); };

    try {
      const ts = await loadTurnstile();
      widgetId = ts.render(capBox, {
        sitekey: cfg.siteKey,
        theme: 'light',
        language: 'zh-tw',
        retry: 'auto',
        'retry-interval': 3000,
        'refresh-expired': 'auto',
        callback: (t) => { token = t; msg.textContent = ''; },
        'expired-callback': () => { token = ''; },
        'timeout-callback': () => { token = ''; },
        'error-callback': (code) => {
          token = '';
          UI.render(capBox, turnstileErrorBox(code, retry));
          // 回傳 false 讓 Cloudflare 不要再蓋掉我們自己畫的說明
          return false;
        },
      });
      activeWidget = widgetId;
    } catch (e) {
      // 載不到 api.js（多半是 challenges.cloudflare.com 被擋）。
      // 這裡「絕對不能」把登入鈕鎖住——伺服器端可能設了連不上就放行，
      // 或管理員剛好已經把人機驗證關掉，鎖住只會讓所有人都進不來。
      UI.render(capBox, turnstileErrorBox('200500', retry));
      msg.textContent = '仍可先試著直接登入；若伺服器要求驗證會再提示。';
      msg.style.color = 'var(--muted, #666)';
    }
  }

  // ── 外框 ────────────────────────────────────────────────
  function shell(active) {
    stopBell();
    document.body.classList.remove('exam-body');
    document.body.style.overflow = '';
    const staff = API.user?.role !== 'student';
    const links = staff
      ? [['#/admin/results', '成績總覽'], ['#/admin/monitor', '即時監看'], ['#/admin/tests', '試卷'],
         ['#/admin/bank', '題庫'], ['#/admin/import', '匯入題目'], ['#/admin/generate', 'AI 出題'],
         ['#/admin/members', '成員'], ['#/admin/assign', '指派考試'], ['#/admin/files', '檔案'],
         ['#/admin/data', '資料管理'], ['#/admin/settings', '系統設定']]
      : [['#/', '我的考試'], ['#/my-results', '我的成績'], ['#/practice', '練習']];

    const main = el('main', { class: 'app-main', id: 'main' });
    UI.render(root(), 
      el('header', { class: 'app-header' },
        el('div', { class: 'brand' }, 'IELTS 模擬考'),
        el('nav', { class: 'app-nav' }, links.map(([href, label]) =>
          el('a', { href, class: href === active ? 'active' : '' }, label))),
        el('div', { class: 'spacer' }),
        bell(),
        el('span', { class: 'small muted who', title: API.user?.name || '' }, API.user?.name || ''),
        el('button', {
          class: 'btn sm ghost', title: '我的帳號', 'aria-label': '我的帳號',
          onclick: () => { location.hash = '#/account'; },
        }, '⚙'),
        el('button', { class: 'btn sm', onclick: () => API.logout() }, '登出')),
      main);
    return main;
  }

  // ── 學生首頁 ────────────────────────────────────────────
  async function studentHome(mount) {
    UI.render(mount, UI.loading('載入你的考試…', 2));
    const { available } = await API.get('/exam/available');

    UI.render(mount,
      el('div', { class: 'toolbar' },
        el('h2', { style: { margin: 0 } }, `${API.user?.name}，你好`),
        el('span', { style: { flex: '1' } }),
        el('a', { class: 'btn sm', href: '#/check' }, '🩺 環境檢查')),
      available.length === 0
        ? el('div', { class: 'card' }, UI.emptyState('目前沒有指派給你的考試', { label: '去練習 →', href: '#/practice' }, '老師指派之後就會出現在這裡。想先自己練可以到「練習」。'))
        : available.map((a) => el('div', { class: 'card' },
            el('div', { style: { display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' } },
              el('div', { style: { flex: '1 1 260px' } },
                el('h3', { style: { marginBottom: '.2rem' } }, a.title),
                el('div', { class: 'small muted' },
                  a.testType === 'general' ? 'General Training' : 'Academic',
                  ' · ', a.modules.map((m) => UI.MODULE_LABEL[m]?.split(' ')[0]).join('、')),
                a.description && el('p', { class: 'small' }, a.description),
                a.openUntil && el('div', { class: 'small muted' }, `開放至 ${fmtDate(a.openUntil)}`),
                el('div', { class: 'small muted' }, `已考 ${a.attempts.filter((x) => x.status !== 'in_progress').length} / ${a.maxAttempts} 次`)),
              el('div', { style: { display: 'flex', flexDirection: 'column', gap: '.4rem' } },
                a.inProgress
                  ? el('button', { class: 'btn primary', onclick: () => startExam(a) }, '繼續考試')
                  : a.canStart
                    ? el('button', { class: 'btn primary', onclick: () => startExam(a) }, '開始考試')
                    : el('span', { class: 'pill warn' }, a.blockedReason || '已達次數上限'))),
            a.attempts.length ? el('div', { style: { marginTop: '.8rem', borderTop: '1px solid var(--line-2)', paddingTop: '.6rem' } },
              el('div', { class: 'small muted', style: { marginBottom: '.3rem' } }, '作答紀錄'),
              a.attempts.map((x) => el('div', { class: 'small', style: { display: 'flex', gap: '.6rem', alignItems: 'center', padding: '.2rem 0' } },
                el('span', { class: 'muted' }, fmtDate(x.started_at)),
                el('span', { class: 'pill' }, { in_progress: '作答中', submitted: '已交卷', grading: '批改中', graded: '已完成' }[x.status] || x.status),
                x.overall_band != null ? el('b', {}, `總分 ${band(x.overall_band)}`) : null,
                x.status !== 'in_progress' ? el('a', { href: `#/result/${x.id}` }, '看成績') : null))) : null)));
  }

  async function startExam(a) {
    // 監考模式下，麥克風權限一定要在「進全螢幕之前」就拿到。
    // 不然學生為了去瀏覽器設定開權限而退出全螢幕，會被記成違規 ——
    // 系統自己造成的問題，卻算在學生頭上。
    if (!Check.recentlyPassed()) {
      const mount = UI.$('#main');
      if (mount) {
        const box = el('div');
        UI.render(mount,
          el('div', { class: 'card', style: { marginBottom: '1rem' } },
            el('h3', { style: { marginTop: 0 } }, '開始之前，先花一分鐘檢查這台電腦'),
            el('p', { class: 'small muted', style: { margin: 0 } },
              '這一步七天內只需要做一次。麥克風權限先在這裡開好，考試中就不會因為去改瀏覽器設定而中斷、被記成離開考試畫面。'),
            el('div', { class: 'toolbar', style: { marginTop: '.6rem' } },
              el('button', { class: 'btn sm', onclick: () => studentHome(mount) }, '← 先回去'))),
          box);
        return Check.render(box, { gate: true, onDone: () => reallyStart(a) });
      }
    }
    return reallyStart(a);
  }

  async function reallyStart(a) {
    try {
      const r = await API.post('/exam/start', { assignmentId: a.assignmentId, testId: a.testId });
      location.hash = `#/exam/${r.attemptId}`;
    } catch (e) { UI.alert(e.message); }
  }

  // ── 學生成績列表 ────────────────────────────────────────
  async function myResults(mount) {
    const { attempts } = await API.get('/exam/my-attempts');
    UI.render(mount, 
      el('h2', {}, '我的成績'),
      el('div', { class: 'card' },
        attempts.length === 0 ? UI.emptyState('還沒有考試紀錄', { label: '看看有沒有考試 →', href: '#/' })
          : UI.dataTable(
              el('thead', {}, el('tr', {},
                el('th', {}, '試卷'), el('th', {}, '日期'), el('th', {}, '狀態'),
                el('th', {}, 'L'), el('th', {}, 'R'), el('th', {}, 'W'), el('th', {}, 'S'),
                el('th', {}, '總分'), el('th', {}, ''))),
              el('tbody', {}, attempts.map((a) => el('tr', {},
                el('td', {}, a.title),
                el('td', { class: 'small muted' }, fmtDate(a.submitted_at || a.started_at)),
                el('td', {}, el('span', { class: 'pill' }, { in_progress: '作答中', submitted: '已交卷', grading: '批改中', graded: '已完成' }[a.status] || a.status)),
                el('td', {}, band(a.listening_band)), el('td', {}, band(a.reading_band)),
                el('td', {}, band(a.writing_band)), el('td', {}, band(a.speaking_band)),
                el('td', {}, el('b', { style: { color: 'var(--brand)' } }, band(a.overall_band))),
                el('td', {}, a.status === 'in_progress'
                  ? el('a', { class: 'btn sm', href: `#/exam/${a.id}` }, '繼續')
                  : el('a', { class: 'btn sm', href: `#/result/${a.id}` }, '成績單'))))))));
  }

  // ── 寫作即時練習 ────────────────────────────────────────
  // ── 練習中心（寫作批改 / 口說練習 / 錯題複習）─────────────
  function practice(mount, params) {
    const panes = [
      ['寫作批改', writingPractice],
      ['口說練習', speakingPractice],
      ['錯題複習', wrongBook],
    ];
    const holder = el('div');
    const bar = el('div', { class: 'tabs' }, panes.map(([label, fn], i) =>
      el('button', {
        class: i === 0 ? 'active' : '',
        onclick: (e) => {
          [...bar.children].forEach((c) => c.classList.remove('active'));
          e.target.classList.add('active');
          UI.render(holder, UI.loading());
          fn(holder);
        },
      }, label)));

    UI.render(mount,
      el('h2', {}, '練習'),
      el('p', { class: 'small muted' }, '不用等老師指派，隨時可以自己練。這裡的練習不會產生成績。'),
      bar, holder);

    // 允許用 #/practice?tab=1 直接開某一頁
    const want = Number(params?.tab) || 0;
    if (want > 0 && want < panes.length) bar.children[want].click();
    else writingPractice(holder);
  }

  function writingPractice(mount) {
    const taskNo = el('select', {}, el('option', { value: 2 }, 'Task 2（議論文）'), el('option', { value: 1 }, 'Task 1（圖表／書信）'));
    const type = el('select', {}, el('option', { value: 'academic' }, 'Academic'), el('option', { value: 'general' }, 'General Training'));
    const prompt = el('textarea', { rows: 4, placeholder: '把題目貼在這裡' });
    const essay = el('textarea', { rows: 14, placeholder: '把你的作文貼在這裡…' });
    const wc = el('b', {}, '0');
    essay.addEventListener('input', () => { wc.textContent = String(essay.value.trim().split(/\s+/).filter(Boolean).length); });
    const out = el('div', {});

    UI.render(mount,
      el('p', { class: 'small muted' }, '貼上題目與作文，就能拿到四大標準分數、逐句修改建議與範文。'),
      el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('label', { class: 'field' }, el('span', {}, '題型'), taskNo),
          el('label', { class: 'field' }, el('span', {}, '類型'), type)),
        el('label', { class: 'field' }, el('span', {}, '題目'), prompt),
        el('label', { class: 'field' }, el('span', {}, '你的作文（字數 ', wc, '）'), essay),
        el('button', {
          class: 'btn primary',
          onclick: async (e) => {
            if (essay.value.trim().length < 30) return UI.alert('請先貼上作文內容');
            e.target.disabled = true; e.target.textContent = 'AI 批改中…';
            try {
              const r = await API.post('/ai/grade-writing', {
                taskNo: Number(taskNo.value), testType: type.value,
                prompt: prompt.value, essay: essay.value,
              });
              showFeedback(r.result);
            } catch (er) { UI.alert(er.message); }
            e.target.disabled = false; e.target.textContent = '送出批改';
          },
        }, '送出批改')),
      out);

    function showFeedback(r) {
      const L = { TA: '任務完成度', CC: '連貫與銜接', LR: '詞彙豐富度', GRA: '文法多樣性與準確度' };
      UI.render(out, el('div', { class: 'card' },
        el('h3', {}, '評分結果 ', el('span', { style: { color: 'var(--brand)' } }, `Band ${band(r.band)}`)),
        Object.entries(L).map(([k, lab]) => {
          const v = Number(r.criteria?.[k]);
          if (Number.isNaN(v)) return null;
          return el('div', { class: 'crit-bar' },
            el('span', { class: 'lbl' }, lab),
            el('span', { class: 'meter' }, el('i', { style: { width: `${(v / 9) * 100}%` } })),
            el('span', { class: 'val' }, v.toFixed(1)));
        }),
        r.summary_zh && el('p', { style: { marginTop: '.8rem' } }, el('b', {}, '總評：'), r.summary_zh),
        r.corrections?.length && el('details', { open: true },
          el('summary', {}, el('b', {}, `逐句修改建議（${r.corrections.length} 處）`)),
          UI.dataTable(
            el('thead', {}, el('tr', {}, el('th', {}, '原句'), el('th', {}, '建議'), el('th', {}, '問題'))),
            el('tbody', {}, r.corrections.map((c) => el('tr', {},
              el('td', {}, el('span', { class: 'diff-del' }, c.original)),
              el('td', {}, el('span', { class: 'diff-ins' }, c.corrected)),
              el('td', { class: 'small muted' }, c.issue_zh || '')))))),
        r.modelAnswer && el('details', {}, el('summary', {}, el('b', {}, '範文')),
          el('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.8', fontFamily: 'Georgia, serif' } }, r.modelAnswer)),
        r.nextSteps_zh?.length && el('div', {}, el('b', {}, '練習建議：'),
          el('ol', { style: { lineHeight: '1.8' } }, r.nextSteps_zh.map((s) => el('li', {}, s))))));
    }
  }

  // ── 口說單獨練習 ────────────────────────────────────────
  async function speakingPractice(mount) {
    const partSel = el('select', {},
      el('option', { value: 1 }, 'Part 1（日常問答）'),
      el('option', { value: 2, selected: true }, 'Part 2（Cue card，講 2 分鐘）'),
      el('option', { value: 3 }, 'Part 3（延伸討論）'));
    const topicIn = el('input', { type: 'text', placeholder: '想練的主題（選填），例如：科技、教育' });
    const qBox = el('div', { class: 'card' }, el('p', { class: 'muted' }, '按「出一題」開始。'));
    const answerBox = el('div');
    const out = el('div');
    let current = null;

    const renderQuestion = (q, part, source) => {
      current = { q, part };
      const src = { bank: '來自題庫', ai: 'AI 出題', builtin: '內建題目' }[source] || '';
      UI.render(qBox,
        el('div', { class: 'toolbar', style: { marginBottom: '.4rem' } },
          el('b', {}, `Part ${part}`),
          el('span', { class: 'pill' }, src)),
        q.cueCard
          ? el('div', { style: { lineHeight: '1.9' } },
              el('h3', { style: { marginBottom: '.3rem' } }, q.cueCard.topic),
              el('ul', {}, (q.cueCard.bullets || []).map((b) => el('li', {}, b))),
              el('p', { class: 'small muted' },
                `準備 ${q.cueCard.prepSec || 60} 秒，作答 ${q.cueCard.talkSec || 120} 秒`))
          : el('div', { style: { lineHeight: '1.9' } },
              q.topic ? el('div', { class: 'small muted' }, q.topic) : null,
              el('ol', {}, (q.items || [q.text || q.question]).filter(Boolean).map((t) => el('li', {}, t)))));
      renderAnswer();
    };

    // 錄音（有麥克風就錄，沒有就打字）
    let rec = null; let chunks = []; let startedAt = 0;
    function renderAnswer() {
      const text = el('textarea', {
        rows: 6, placeholder: '把你的回答打成文字，或用下面的錄音鈕（需要 HTTPS 或 localhost）',
      });
      const recBtn = el('button', { class: 'btn' }, '🎙 開始錄音');
      const recState = el('span', { class: 'small muted' });
      const send = el('button', { class: 'btn primary' }, '送出評分');

      recBtn.onclick = async () => {
        if (rec && rec.state === 'recording') {
          rec.stop();
          return;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          return UI.alert('這個瀏覽器不支援錄音，請直接把回答打成文字。');
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          rec = new MediaRecorder(stream);
          chunks = [];
          startedAt = Date.now();
          rec.ondataavailable = (e) => chunks.push(e.data);
          rec.onstop = () => {
            stream.getTracks().forEach((t) => t.stop());
            recBtn.textContent = '🎙 重新錄音';
            recState.textContent = `已錄 ${Math.round((Date.now() - startedAt) / 1000)} 秒`;
          };
          rec.start();
          recBtn.textContent = '⏹ 停止錄音';
          recState.textContent = '錄音中…';
        } catch (e) {
          UI.alert(`拿不到麥克風權限：${e.message}\n可以直接把回答打成文字。`);
        }
      };

      send.onclick = async () => {
        if (!current) return UI.alert('請先出一題');
        const typed = text.value.trim();
        if (!typed && !chunks.length) return UI.alert('請先錄音或打字作答');
        send.disabled = true; send.textContent = 'AI 評分中…';
        try {
          const qText = current.q.cueCard
            ? current.q.cueCard.topic
            : (current.q.items || []).join(' / ') || current.q.text || '';
          const fd = new FormData();
          fd.append('part', String(current.part));
          fd.append('question', qText);
          fd.append('duration', String(chunks.length ? Math.round((Date.now() - startedAt) / 1000) : 0));
          if (typed) fd.append('transcript', typed);
          else fd.append('audio', new Blob(chunks, { type: 'audio/webm' }), 'answer.webm');
          const r = await API.post('/practice/speaking/grade', fd);
          showSpeakingResult(r);
        } catch (e) {
          UI.alert(e.message);
        }
        send.disabled = false; send.textContent = '送出評分';
      };

      UI.render(answerBox, el('div', { class: 'card' },
        el('label', { class: 'field' }, el('span', {}, '你的回答'), text),
        el('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' } },
          recBtn, recState, el('span', { style: { flex: 1 } }), send)));
    }

    function showSpeakingResult(r) {
      const res = r.result || {};
      const L = { FC: '流暢度與連貫性', LR: '詞彙豐富度', GRA: '文法多樣性與準確度', PRO: '發音' };
      UI.render(out, el('div', { class: 'card' },
        el('h3', {}, '評分結果 ',
          el('span', { style: { color: 'var(--brand)' } }, `Band ${band(res.band)}`)),
        Object.entries(L).map(([k, lab]) => {
          const v = Number(res.criteria?.[k]);
          if (Number.isNaN(v)) return null;
          return el('div', { class: 'crit-bar' },
            el('span', { class: 'lbl' }, lab),
            el('span', { class: 'meter' }, el('i', { style: { width: `${(v / 9) * 100}%` } })),
            el('span', { class: 'val' }, v.toFixed(1)));
        }),
        res.summary_zh ? el('p', { style: { marginTop: '.8rem' } }, el('b', {}, '總評：'), res.summary_zh) : null,
        res.nextSteps_zh?.length ? el('div', {}, el('b', {}, '練習建議：'),
          el('ol', { style: { lineHeight: '1.8' } }, res.nextSteps_zh.map((s) => el('li', {}, s)))) : null,
        r.sttError ? el('p', { class: 'small', style: { color: 'var(--warn)' } }, `語音辨識提醒：${r.sttError}`) : null,
        el('details', {}, el('summary', {}, '我說了什麼（逐字稿）'),
          el('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.8' } }, r.transcript || '（沒有逐字稿）'))));
    }

    UI.render(mount,
      el('p', { class: 'small muted' },
        '挑一個 Part 就能練，不用開整場考試。可以錄音（需要 HTTPS 或 localhost）或直接打字。'),
      el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('label', { class: 'field' }, el('span', {}, '要練哪一部分'), partSel),
          el('label', { class: 'field' }, el('span', {}, '主題'), topicIn)),
        el('button', {
          class: 'btn primary',
          onclick: async (e) => {
            e.target.disabled = true; e.target.textContent = '出題中…';
            try {
              const r = await API.post('/practice/speaking/question', {
                part: Number(partSel.value), topic: topicIn.value.trim(),
              });
              renderQuestion(r.question, r.part, r.source);
              UI.render(out);
            } catch (er) { UI.alert(er.message); }
            e.target.disabled = false; e.target.textContent = '出一題';
          },
        }, '出一題')),
      qBox, answerBox, out);
  }

  // ── 錯題複習 ────────────────────────────────────────────
  const WRONG_TYPE_LABEL = {
    mcq_single: '單選', mcq_multi: '多選', tfng: 'T/F/NG', ynng: 'Y/N/NG',
    matching: '配對', gap_fill: '填空', gap_fill_bank: '選字填空',
    short_answer: '簡答', label_image: '圖表標示',
  };

  async function wrongBook(mount) {
    const filter = { module: '', type: '' };
    const box = el('div');
    const summary = el('div');

    async function load() {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(filter)) if (v) qs.set(k, v);
      let d;
      try { d = await API.get(`/practice/wrong?${qs}`); }
      catch (e) { return UI.render(box, UI.errorState(e.message, load)); }

      UI.render(summary,
        d.byType.length
          ? el('div', { class: 'card' },
              el('h3', {}, '我最常錯的題型'),
              d.byType.slice(0, 6).map((t) => el('div', { class: 'crit-bar' },
                el('span', { class: 'lbl' }, WRONG_TYPE_LABEL[t.type] || t.label),
                el('span', { class: 'meter' }, el('i', {
                  style: { width: `${Math.min(100, (t.wrong / d.byType[0].wrong) * 100)}%`, background: 'var(--err)' },
                })),
                el('span', { class: 'val' }, `${t.wrong} 題`))),
              el('div', { style: { marginTop: '.7rem' } },
                el('button', {
                  class: 'btn primary',
                  onclick: () => startDrill(filter),
                }, '▶ 重做這些題目')))
          : null);

      UI.render(box, d.items.length === 0
        ? el('div', { class: 'empty' },
            d.byType.length ? '沒有符合條件的錯題。' : '還沒有錯題紀錄 —— 考完一場批改完就會出現在這裡。')
        : d.items.map((it) => el('div', { class: 'card' },
            el('div', { class: 'small muted', style: { marginBottom: '.3rem' } },
              `${it.testTitle}　·　${UI.MODULE_LABEL[it.module]?.split(' ')[0]}　第 ${it.number} 題　·　`,
              WRONG_TYPE_LABEL[it.type] || it.type,
              it.submittedAt ? `　·　${fmtDate(it.submittedAt)}` : ''),
            it.instructions ? el('div', { class: 'small muted' }, it.instructions) : null,
            el('p', { style: { fontWeight: '500' } }, it.text || '（這題的題幹在版面裡，請看下方原文）'),
            it.bodyHtml
              ? el('div', { class: 'rev-body small', html: UI.sanitize(it.bodyHtml) }) : null,
            it.image ? el('img', { src: it.image, class: 'rev-img', alt: '題目圖片', loading: 'lazy' }) : null,
            it.options?.length
              ? el('div', { class: 'small muted' },
                  it.options.map((o) => `${o.key}. ${o.text}`).join('　')) : null,
            // 沒有原文的話，閱讀錯題根本沒得檢討 —— 學生看不出當初為什麼選錯
            srcBlock(d.passages?.[it.passageKey]),
            el('div', { style: { display: 'flex', gap: '1.2rem', flexWrap: 'wrap', marginTop: '.4rem' } },
              el('div', {}, el('span', { class: 'small muted' }, '你的答案　'),
                el('b', { style: { color: 'var(--err)' } }, it.yourAnswer || '（空白）')),
              el('div', {}, el('span', { class: 'small muted' }, '正確答案　'),
                el('b', { style: { color: 'var(--ok)' } }, it.expected || '—'))),
            it.explanation
              ? el('details', { style: { marginTop: '.4rem' } },
                  el('summary', { class: 'small' }, '看解析'),
                  el('div', { class: 'small', style: { lineHeight: '1.8' } }, it.explanation))
              : null)));
    }

    UI.render(mount,
      el('p', { class: 'small muted' },
        '把你考過而且已批改的場次裡答錯的題目整理在這裡。可以逐題看解析，也可以整批重做一次。'),
      el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('label', { class: 'field' }, el('span', {}, '科目'),
            el('select', {
              onchange: (e) => { filter.module = e.target.value; load(); },
            }, [['', '全部'], ['listening', '聽力'], ['reading', '閱讀']].map(([v, l]) =>
              el('option', { value: v }, l)))),
          el('label', { class: 'field' }, el('span', {}, '題型'),
            el('select', {
              onchange: (e) => { filter.type = e.target.value; load(); },
            }, [['', '全部']].concat(Object.entries(WRONG_TYPE_LABEL)).map((x) =>
              el('option', { value: x[0] }, x[1])))))),
      summary, box);

    load();
  }

  /** 錯題／重做共用：把那一節的原文或逐字稿附上去 */
  function srcBlock(p) {
    if (!p || (!p.passage && !p.transcript)) return null;
    return el('details', { class: 'rev-src' },
      el('summary', {}, p.passage ? '📄 看原文' : '🎧 看逐字稿',
        p.title ? el('span', { class: 'muted small' }, `　${p.title}`) : null),
      el('div', { class: 'rev-src-body' },
        p.passage ? el('div', { class: 'passage', html: UI.sanitize(p.passage) }) : null,
        p.transcript ? el('pre', { class: 'transcript' }, p.transcript) : null));
  }

  /** 錯題重做 */
  async function startDrill(filter) {
    let d;
    try { d = await API.post('/practice/drill', { ...filter, count: 10 }); }
    catch (e) { return UI.alert(e.message); }
    if (!d.items.length) return UI.alert('沒有可以重做的題目');

    const responses = {};
    const body = el('div', {}, d.items.map((it, i) => {
      const input = it.options?.length
        ? el('select', {
            onchange: (e) => { responses[it.key] = e.target.value; },
          }, el('option', { value: '' }, '（選一個）'),
            it.options.map((o) => el('option', { value: o.key }, `${o.key}. ${o.text}`)))
        : el('input', {
            type: 'text', placeholder: it.wordLimit ? `最多 ${it.wordLimit} 個字` : '',
            oninput: (e) => { responses[it.key] = e.target.value; },
          });
      return el('div', { style: { padding: '.6rem 0', borderBottom: '1px solid var(--line-2)' } },
        el('div', { class: 'small muted' },
          `${i + 1}.　${it.testTitle}　第 ${it.number} 題　·　${WRONG_TYPE_LABEL[it.type] || it.type}`),
        it.instructions ? el('div', { class: 'small muted' }, it.instructions) : null,
        srcBlock(d.passages?.[it.passageKey]),
        el('p', { style: { margin: '.3rem 0' } }, it.text || '（題幹在版面裡）'),
        it.bodyHtml ? el('div', { class: 'rev-body small', html: UI.sanitize(it.bodyHtml) }) : null,
        it.image ? el('img', { src: it.image, class: 'rev-img', alt: '題目圖片', loading: 'lazy' }) : null,
        input);
    }));

    const go = await UI.modal({
      title: `重做 ${d.items.length} 題`,
      width: '720px',
      body,
      actions: [{ label: '交卷看結果', value: true, class: 'primary' }, { label: '取消', value: false }],
    });
    if (!go) return;

    let r;
    try { r = await API.post('/practice/drill/check', { responses }); }
    catch (e) { return UI.alert(e.message); }

    const byKey = new Map(r.results.map((x) => [x.key, x]));
    await UI.modal({
      title: `答對 ${r.correct} / ${r.total}`,
      width: '720px',
      body: el('div', {},
        el('p', { class: 'small muted' }, '這次練習不會影響你的正式成績。'),
        d.items.map((it) => {
          const res = byKey.get(it.key);
          if (!res) return null;
          return el('div', { style: { padding: '.5rem 0', borderBottom: '1px solid var(--line-2)' } },
            el('div', {},
              el('b', { style: { color: res.correct ? 'var(--ok)' : 'var(--err)' } }, res.correct ? '✓ ' : '✗ '),
              it.text || `第 ${it.number} 題`),
            el('div', { class: 'small' },
              '你填：', el('b', {}, res.yourAnswer || '（空白）'),
              '　正解：', el('b', { style: { color: 'var(--ok)' } }, res.expected)),
            res.explanation
              ? el('div', { class: 'small muted', style: { marginTop: '.2rem' } }, res.explanation) : null);
        })),
      actions: [{ label: '關閉', value: true }],
    });
  }

  /* ── 通知鈴鐺 ────────────────────────────────────────
     指派考試、批改完成、老師發訊息都會進來。
     只輪詢一支很小的 /count，開啟清單時才拉完整內容。 */
  let bellTimer = null;
  function stopBell() { clearInterval(bellTimer); bellTimer = null; }

  function bell() {
    const badge = el('span', { class: 'bell-badge', style: { display: 'none' } });
    const btn = el('button', {
      class: 'btn sm ghost bell', title: '通知', 'aria-label': '通知',
      onclick: () => openNotifications(refresh),
    }, '🔔', badge);

    const refresh = async () => {
      try {
        const { unread } = await API.get('/notifications/count');
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.style.display = unread ? '' : 'none';
        btn.classList.toggle('has-unread', unread > 0);
      } catch { /* 沒連上就先不管 */ }
    };

    stopBell();
    refresh();
    bellTimer = setInterval(refresh, 60_000);
    return btn;
  }

  async function openNotifications(after) {
    let d;
    try { d = await API.get('/notifications?limit=30'); }
    catch (e) { return UI.alert(e.message); }

    const rows = d.items.length
      ? el('div', {}, d.items.map((n) => el('div', {
          class: 'notif' + (n.read_at ? '' : ' unread'),
          onclick: () => {
            if (!n.link) return;
            $$('.modal-back').forEach((b) => b.remove());
            location.hash = n.link;
          },
        },
          el('div', { class: 'notif-title' }, n.title),
          n.body ? el('div', { class: 'notif-body' }, n.body) : null,
          el('div', { class: 'notif-time' }, fmtDate(n.created_at)))))
      : UI.emptyState('目前沒有通知', null, '指派考試、成績出來時會出現在這裡。');

    await UI.modal({
      title: d.unread ? `通知（${d.unread} 則未讀）` : '通知',
      width: '520px',
      body: rows,
      actions: [
        ...(d.unread ? [{ label: '全部標為已讀', value: 'read', class: 'primary' }] : []),
        { label: '關閉', value: false },
      ],
    }).then(async (v) => {
      if (v === 'read') {
        await API.post('/notifications/read', {}).catch(() => {});
        if (after) after();
      }
    });
  }

  // ── 帳號設定 ────────────────────────────────────────────
  function account(mount) {
    const oldP = el('input', { type: 'password' });
    const newP = el('input', { type: 'password' });
    UI.render(mount, 
      el('h2', {}, '我的帳號'),
      el('div', { class: 'card' },
        el('p', {}, el('b', {}, API.user?.name), '　', el('span', { class: 'muted' }, API.user?.username),
          '　', el('span', { class: 'pill' }, { admin: '管理員', teacher: '老師', student: '學生' }[API.user?.role])),
        el('h3', { style: { marginTop: '1rem' } }, '修改密碼'),
        el('label', { class: 'field' }, el('span', {}, '目前密碼'), oldP),
        el('label', { class: 'field' }, el('span', {}, '新密碼（至少 6 字元）'), newP),
        el('button', {
          class: 'btn primary',
          onclick: async () => {
            try {
              await API.post('/auth/password', { oldPassword: oldP.value, newPassword: newP.value });
              toast('密碼已更新', 'ok'); oldP.value = newP.value = '';
            } catch (e) { UI.alert(e.message); }
          },
        }, '更新密碼')));
  }

  // ── 路由 ────────────────────────────────────────────────
  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = raw.split('?');
    const params = Object.fromEntries(new URLSearchParams(qs || ''));
    return { path, params };
  }

  async function route() {
    const { path, params } = parseHash();

    // 離開哪一頁都先停掉背景輪詢（例如即時監看的 4 秒更新）
    try { Admin.stopPolling(); } catch { /* Admin 還沒載入 */ }

    // 考前環境檢查不用登入 —— 學生考前一天在家就能自己測，
    // 麥克風權限先在這裡拿到，考試中就不必為了改設定而退出全螢幕。
    if (path === '/check') {
      stopBell();
      document.body.classList.remove('exam-body');
      document.body.style.overflow = '';
      const mount = el('main', { class: 'app-main check-page', id: 'main' });
      UI.render(root(),
        el('header', { class: 'app-header' },
          el('div', { class: 'brand' }, 'IELTS 模擬考'),
          el('div', { class: 'spacer' }),
          el('a', { class: 'btn sm', href: API.token ? '#/' : '#/login' }, API.token ? '回首頁' : '登入')),
        mount);
      return await Check.render(mount);
    }

    if (!API.token) return loginPage();
    if (path === '/login') { location.hash = '#/'; return; }

    // 考試畫面是全螢幕，不套外框
    const examMatch = path.match(/^\/exam\/(\d+)$/);
    if (examMatch) return Exam.open(Number(examMatch[1]));

    const editMatch = path.match(/^\/admin\/edit\/(\d+)$/);

    const resultMatch = path.match(/^\/result\/(\d+)$/);
    const staff = API.user?.role !== 'student';

    let active = path;
    if (resultMatch) active = staff ? '#/admin/results' : '#/my-results';
    else if (editMatch) active = '#/admin/tests';
    else active = `#${path}`;

    const mount = shell(active);
    try {
      // 一定要 await。`return promise` 不會讓 rejection 走到下面的 catch，
      // 所以任何一頁載入失敗都只會留下一片空白，連錯誤訊息都沒有。
      if (resultMatch) return await Results.render(Number(resultMatch[1]), mount);
      if (editMatch) return await Admin.editPaper(mount, Number(editMatch[1]));
      switch (path) {
        case '/': return await (staff ? Admin.results(mount) : studentHome(mount));
        case '/my-results': return await myResults(mount);
        case '/practice': return await practice(mount, params);
        case '/account': return await account(mount);
        case '/admin/tests': return await Admin.tests(mount);
        case '/admin/import': return await Admin.importPage(mount);
        case '/admin/generate': return await Admin.generate(mount);
        case '/admin/bank': return await Admin.bank(mount);
        case '/admin/members': return await Admin.members(mount);
        case '/admin/students': location.hash = '#/admin/members'; return;
        case '/admin/assign': return await Admin.assign(mount, params);
        case '/admin/results': return await Admin.results(mount);
        case '/admin/files': return await Admin.files(mount);
        case '/admin/data': return await Admin.data(mount);
        case '/admin/monitor': return await Admin.monitor(mount);
        case '/admin/settings': return await Admin.settings(mount);
        default:
          UI.render(mount, el('div', { class: 'empty' }, '找不到這個頁面。'));
      }
    } catch (e) {
      console.error('[route]', path, e);
      UI.render(mount, UI.errorState(e.message, () => route()));
    }
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('DOMContentLoaded', route);
  if (document.readyState !== 'loading') route();
})();
