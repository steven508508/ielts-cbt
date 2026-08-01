/* ═══════════════════════════════════════════════════════════
   路由與主要頁面
   ═══════════════════════════════════════════════════════════ */
(() => {
  const { el, band, fmtDate, toast } = UI;
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
          '忘記密碼請找老師或管理員重設。'))));

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
    document.body.classList.remove('exam-body');
    document.body.style.overflow = '';
    const staff = API.user?.role !== 'student';
    const links = staff
      ? [['#/admin/results', '成績總覽'], ['#/admin/monitor', '即時監看'], ['#/admin/tests', '試卷'],
         ['#/admin/bank', '題庫'], ['#/admin/import', '匯入題目'], ['#/admin/generate', 'AI 出題'],
         ['#/admin/members', '成員'], ['#/admin/assign', '指派考試'], ['#/admin/files', '檔案'],
         ['#/admin/data', '資料管理'], ['#/admin/settings', '系統設定']]
      : [['#/', '我的考試'], ['#/my-results', '我的成績'], ['#/practice', '寫作練習']];

    const main = el('main', { class: 'app-main', id: 'main' });
    UI.render(root(), 
      el('header', { class: 'app-header' },
        el('div', { class: 'brand' }, 'IELTS 模擬考'),
        el('nav', { class: 'app-nav' }, links.map(([href, label]) =>
          el('a', { href, class: href === active ? 'active' : '' }, label))),
        el('div', { style: { flex: 1 } }),
        el('span', { class: 'small muted' }, API.user?.name || ''),
        el('button', { class: 'btn sm ghost', onclick: () => { location.hash = '#/account'; } }, '⚙'),
        el('button', { class: 'btn sm', onclick: () => API.logout() }, '登出')),
      main);
    return main;
  }

  // ── 學生首頁 ────────────────────────────────────────────
  async function studentHome(mount) {
    UI.render(mount, el('div', { class: 'empty' }, '載入中…'));
    const { available } = await API.get('/exam/available');

    UI.render(mount, 
      el('h2', {}, `${API.user?.name}，你好`),
      available.length === 0
        ? el('div', { class: 'card' }, el('div', { class: 'empty' }, '目前沒有指派給你的考試。'))
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
        attempts.length === 0 ? el('div', { class: 'empty' }, '還沒有考試紀錄。')
          : el('table', { class: 'data' },
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
  function practice(mount) {
    const taskNo = el('select', {}, el('option', { value: 2 }, 'Task 2（議論文）'), el('option', { value: 1 }, 'Task 1（圖表／書信）'));
    const type = el('select', {}, el('option', { value: 'academic' }, 'Academic'), el('option', { value: 'general' }, 'General Training'));
    const prompt = el('textarea', { rows: 4, placeholder: '把題目貼在這裡' });
    const essay = el('textarea', { rows: 14, placeholder: '把你的作文貼在這裡…' });
    const wc = el('b', {}, '0');
    essay.addEventListener('input', () => { wc.textContent = String(essay.value.trim().split(/\s+/).filter(Boolean).length); });
    const out = el('div', {});

    UI.render(mount, 
      el('h2', {}, '寫作即時批改'),
      el('p', { class: 'small muted' }, '不用整場考試，貼上題目與作文就能拿到四大標準分數、逐句修改建議與範文。'),
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
          el('table', { class: 'data' },
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

    if (!API.token) return loginPage();
    if (path === '/login') { location.hash = '#/'; return; }

    // 考試畫面是全螢幕，不套外框
    const examMatch = path.match(/^\/exam\/(\d+)$/);
    if (examMatch) return Exam.open(Number(examMatch[1]));

    const resultMatch = path.match(/^\/result\/(\d+)$/);
    const staff = API.user?.role !== 'student';

    let active = path;
    if (resultMatch) active = staff ? '#/admin/results' : '#/my-results';
    else active = `#${path}`;

    const mount = shell(active);
    try {
      if (resultMatch) return Results.render(Number(resultMatch[1]), mount);
      switch (path) {
        case '/': return staff ? Admin.results(mount) : studentHome(mount);
        case '/my-results': return myResults(mount);
        case '/practice': return practice(mount);
        case '/account': return account(mount);
        case '/admin/tests': return Admin.tests(mount);
        case '/admin/import': return Admin.importPage(mount);
        case '/admin/generate': return Admin.generate(mount);
        case '/admin/bank': return Admin.bank(mount);
        case '/admin/members': return Admin.members(mount);
        case '/admin/students': location.hash = '#/admin/members'; return;
        case '/admin/assign': return Admin.assign(mount, params);
        case '/admin/results': return Admin.results(mount);
        case '/admin/files': return Admin.files(mount);
        case '/admin/data': return Admin.data(mount);
        case '/admin/monitor': return Admin.monitor(mount);
        case '/admin/settings': return Admin.settings(mount);
        default:
          UI.render(mount, el('div', { class: 'empty' }, '找不到這個頁面。'));
      }
    } catch (e) {
      UI.render(mount, el('div', { class: 'card' },
        el('h3', {}, '發生錯誤'), el('p', {}, e.message)));
    }
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('DOMContentLoaded', route);
  if (document.readyState !== 'loading') route();
})();
