/* ═══════════════════════════════════════════════════════════
   老師 / 管理員後台
   ═══════════════════════════════════════════════════════════ */
const Admin = (() => {
  let jobTimer = null;   // AI 全卷產生的進度輪詢（換頁要停掉）
  const { el, $, sanitize, toast, band, fmtDate } = UI;

  // ── 試卷管理 ────────────────────────────────────────────
  async function tests(mount) {
    UI.render(mount, UI.loading('載入試卷…', 4));
    const { tests: list } = await API.get('/tests');
    UI.render(mount, 
      el('div', { class: 'toolbar' },
        el('h2', { style: { margin: 0 } }, '試卷管理'),
        el('span', { style: { flex: 1 } }),
        el('a', { class: 'btn', href: '#/admin/import' }, '＋ 匯入題目'),
        el('a', { class: 'btn primary', href: '#/admin/generate' }, '✨ AI 出題')),
      el('div', { class: 'card' },
        list.length === 0
          ? UI.emptyState('還沒有試卷', { label: '＋ 匯入題目', href: '#/admin/import' }, '也可以用「AI 出題」直接產生一份完整試卷。')
          : UI.dataTable(
              el('thead', {}, el('tr', {},
                el('th', {}, '標題'), el('th', {}, '類型'), el('th', {}, '狀態'),
                el('th', {}, '建立者'), el('th', {}, '更新時間'), el('th', {}, ''))),
              el('tbody', {}, list.map((t) => el('tr', {},
                el('td', {}, el('b', {}, t.title), t.description ? el('div', { class: 'small muted' }, t.description) : null),
                el('td', {}, t.test_type === 'general' ? 'General' : 'Academic'),
                el('td', {}, t.published ? el('span', { class: 'pill ok' }, '已發布') : el('span', { class: 'pill' }, '草稿')),
                el('td', { class: 'small' }, t.author || '—'),
                el('td', { class: 'small muted' }, fmtDate(t.updated_at)),
                el('td', { style: { whiteSpace: 'nowrap' } },
                  el('button', { class: 'btn sm', onclick: () => preview(t.id) }, '預覽'),
                  ' ',
                  el('button', {
                    class: 'btn sm' + (t.missingMedia ? ' danger' : ''),
                    title: '補文章、音檔、圖片',
                    onclick: () => editMedia(t.id, () => tests(mount)),
                  }, t.missingMedia ? `素材 ⚠${t.missingMedia}` : '素材'),
                  ' ',
                  el('a', { class: 'btn sm', href: `#/admin/edit/${t.id}`, title: '改題目、選項、答案' }, '題目'),
                  ' ',
                  el('button', {
                    class: 'btn sm',
                    onclick: async () => {
                      await API.put(`/tests/${t.id}`, { published: !t.published });
                      toast(t.published ? '已取消發布' : '已發布', 'ok'); tests(mount);
                    },
                  }, t.published ? '取消發布' : '發布'),
                  ' ',
                  el('button', {
                    class: 'btn sm', onclick: () => { location.hash = `#/admin/assign?test=${t.id}`; },
                  }, '指派'),
                  ' ',
                  el('button', {
                    class: 'btn sm',
                    onclick: () => window.open(`/api/import/export/${t.id}?token=${encodeURIComponent(API.token)}`),
                  }, '匯出'),
                  ' ',
                  el('button', {
                    class: 'btn sm danger',
                    onclick: async () => {
                      if (!(await UI.confirm(`確定刪除「${t.title}」？相關成績也會一併刪除。`))) return;
                      await API.del(`/tests/${t.id}`); toast('已刪除', 'ok'); tests(mount);
                    },
                  }, '刪除'))))))));
  }

  /**
   * 存檔後如果驗證有「沒有文章／沒有音檔」這類警告，一定要講出來。
   * 這種東西存的當下沒感覺，等到學生開始考試才發現左邊一片空白就來不及了。
   */
  async function warnIfMissingMedia(warnings) {
    const media = (warnings || []).filter((w) => /沒有 passage|沒有指定 audio|建議提供 image/.test(w));
    if (!media.length) return;
    await UI.alert(el('div', {},
      el('p', {}, el('b', {}, '試卷存好了，但學生端會缺東西：')),
      el('ul', { class: 'small' }, media.map((w) => el('li', {}, w))),
      el('p', { class: 'small muted' },
        '到「試卷管理 → 素材」補上文章內容或音檔網址即可。'
        + '沒補的話，學生開始考試時閱讀區會顯示「（沒有文章內容）」、聽力沒有聲音。')),
    '請補上素材');
  }

  /**
   * 素材編輯 —— 專門補文章、音檔、圖片、逐字稿。
   * 題目本身不動，所以不必擔心改壞題號或答案。
   */
  async function editMedia(id, after) {
    const d = await API.get(`/tests/${id}`);
    const paper = d.paper;
    const fields = [];

    const panes = paper.modules.map((m) => {
      const rows = m.sections.map((sec, si) => {
        const f = { module: m.module, si, sec };
        const needPassage = m.module === 'reading';
        const needAudio = m.module === 'listening';
        const missing = (needPassage && !sec.passage) || (needAudio && !sec.audio);

        const box = el('div', {
          style: {
            padding: '.6rem .7rem', marginBottom: '.5rem', borderRadius: '4px',
            border: `1px solid ${missing ? '#e6b8b3' : 'var(--line-2)'}`,
            background: missing ? '#fdf0ee' : '#fff',
          },
        },
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '.4rem' } },
            el('b', {}, sec.title),
            missing ? el('span', { class: 'pill', style: { background: '#c0392b', color: '#fff' } }, '缺素材') : null,
            el('span', { class: 'small muted' },
              `　${(sec.groups || []).reduce((n, g) => n + (g.questions?.length || 0), 0)} 題`)),

          needPassage ? el('label', { class: 'field' }, el('span', {}, '文章標題'),
            (f.passageTitle = el('input', { type: 'text', value: sec.passageTitle || '' }))) : null,
          needPassage ? el('label', { class: 'field' },
            el('span', {}, '文章內容（可直接貼純文字，會自動分段；也接受 HTML）'),
            (f.passage = el('textarea', { rows: 8 }, sec.passage || ''))) : null,

          needAudio ? el('label', { class: 'field' },
            el('span', {}, '音檔網址（到「檔案」上傳後複製，例如 /uploads/audio/xxx.mp3）'),
            (f.audio = el('input', { type: 'text', value: sec.audio || '', placeholder: '/uploads/audio/…' }))) : null,
          needAudio ? el('label', { class: 'field' },
            el('span', {}, '聽力逐字稿（只有老師看得到，學生考試時不會顯示）'),
            (f.transcript = el('textarea', { rows: 4 }, sec.transcript || ''))) : null,

          el('label', { class: 'field' },
            el('span', {}, '本節圖片網址（地圖／平面圖，選填）'),
            (f.image = el('input', { type: 'text', value: sec.image || '', placeholder: '/uploads/image/…' }))),

          (sec.groups || []).some((g) => ['label_image', 'matching'].includes(g.type))
            ? el('div', { class: 'small muted' }, '這一節有圖表標示題，題組層的圖片請在下方分別填寫。')
            : null,

          el('div', {}, (sec.groups || []).map((g, gi) => {
            if (!['label_image'].includes(g.type) && !g.image) return null;
            const gf = el('input', { type: 'text', value: g.image || '', placeholder: '/uploads/image/…' });
            f.groupImages = f.groupImages || {};
            f.groupImages[gi] = gf;
            return el('label', { class: 'field' },
              el('span', {}, `題組 ${gi + 1}（${g.type}）圖片`), gf);
          })),

          m.module === 'writing'
            ? el('div', {}, (sec.groups || []).flatMap((g, gi) => (g.questions || []).map((q, qi) => {
                const qf = el('input', { type: 'text', value: q.image || '', placeholder: '/uploads/image/…' });
                f.taskImages = f.taskImages || {};
                f.taskImages[`${gi}:${qi}`] = qf;
                return el('label', { class: 'field' },
                  el('span', {}, `Task ${q.taskNo || q.number} 圖表`), qf);
              })))
            : null);

        fields.push(f);
        return box;
      });
      return el('details', { open: m.module === 'reading' || m.module === 'listening' },
        el('summary', {}, el('b', {}, UI.MODULE_LABEL[m.module]), ` — ${m.sections.length} 節`),
        el('div', { style: { paddingTop: '.5rem' } }, rows));
    });

    const ok = await UI.modal({
      title: `素材 — ${paper.title}`,
      width: '820px',
      body: el('div', {},
        el('p', { class: 'small muted' },
          '這裡只改文章、音檔與圖片，題目與答案完全不動。'
          + '標紅色的是學生端會開天窗的地方。'),
        panes),
      actions: [{ label: '儲存', value: true, class: 'primary' }, { label: '取消', value: false }],
    });
    if (!ok) return;

    for (const f of fields) {
      const mod = paper.modules.find((m) => m.module === f.module);
      const sec = mod.sections[f.si];
      if (f.passageTitle) sec.passageTitle = f.passageTitle.value.trim() || null;
      if (f.passage) sec.passage = f.passage.value.trim() || null;
      if (f.audio) sec.audio = f.audio.value.trim() || null;
      if (f.transcript) sec.transcript = f.transcript.value.trim() || null;
      if (f.image) sec.image = f.image.value.trim() || null;
      for (const [gi, input] of Object.entries(f.groupImages || {})) {
        sec.groups[gi].image = input.value.trim() || null;
      }
      for (const [key, input] of Object.entries(f.taskImages || {})) {
        const [gi, qi] = key.split(':').map(Number);
        sec.groups[gi].questions[qi].image = input.value.trim() || null;
      }
    }

    try {
      const r = await API.put(`/tests/${id}`, { paper, published: d.test.published });
      const still = (r.warnings || []).filter((w) => /沒有 passage|沒有指定 audio/.test(w));
      toast(still.length ? `已儲存，還有 ${still.length} 節缺素材` : '素材已補齊', still.length ? '' : 'ok');
      if (after) after();
    } catch (e) {
      UI.alert(e.details?.errors?.join('\n') || e.message);
    }
  }

  async function preview(id) {
    const d = await API.get(`/tests/${id}`);
    const p = d.paper;
    const body = el('div', {},
      el('p', { class: 'small muted' }, `聽力 ${d.stats.listening} 題　閱讀 ${d.stats.reading} 題`),
      p.modules.map((m) => el('details', { open: true, style: { marginBottom: '.5rem' } },
        el('summary', {}, el('b', {}, UI.MODULE_LABEL[m.module]), ` — ${m.sections.length} 個 section`),
        el('div', { style: { paddingLeft: '1rem' } }, m.sections.map((s) =>
          el('div', { style: { padding: '.35rem 0', borderBottom: '1px solid var(--line-2)' } },
            el('b', { class: 'small' }, s.title),
            s.audio ? el('span', { class: 'pill info', style: { marginLeft: '.4rem' } }, '有音檔') : null,
            s.passage ? el('span', { class: 'pill', style: { marginLeft: '.4rem' } }, '有文章') : null,
            el('div', { class: 'small muted' }, (s.groups || []).map((g) =>
              `${g.type}（${g.questions?.length || 0} 題）`).join('、'))))))));
    UI.modal({ title: p.title, body, width: '760px', actions: [{ label: '關閉', value: true }] });
  }

  // ── 匯入 ────────────────────────────────────────────────
  function importPage(mount) {
    let staged = null;   // 待儲存的試卷

    const out = el('div', { class: 'card' }, el('p', { class: 'muted' }, '匯入結果會顯示在這裡。'));

    function showResult(r) {
      staged = r.ok ? r.paper : null;
      UI.render(out, 
        el('h3', {}, r.ok ? '✅ 解析成功' : '❌ 有錯誤需要修正'),
        r.stats && el('p', {}, `聽力 ${r.stats.listening} 題　閱讀 ${r.stats.reading} 題　寫作 ${r.stats.writingTasks} 題　口說 ${r.stats.speakingParts} 個部分`),
        r.errors?.length ? el('div', {}, el('b', { style: { color: 'var(--err)' } }, '錯誤：'),
          el('ul', { class: 'small' }, r.errors.map((e) => el('li', { style: { color: 'var(--err)' } }, e)))) : null,
        r.warnings?.length ? el('div', {}, el('b', { style: { color: 'var(--warn)' } }, '提醒：'),
          el('ul', { class: 'small' }, r.warnings.map((w) => el('li', { class: 'muted' }, w)))) : null,
        r.paper ? el('details', {}, el('summary', { class: 'small muted' }, '看解析後的 JSON'),
          el('pre', { style: { maxHeight: '320px', overflow: 'auto', background: '#fafafa', padding: '.7rem', fontSize: '.78rem' } },
            JSON.stringify(r.paper, null, 2))) : null,
        r.ok ? el('div', { style: { marginTop: '.8rem', display: 'flex', gap: '.5rem' } },
          el('button', { class: 'btn primary', onclick: save }, '存成新試卷'),
          el('button', { class: 'btn', onclick: mergeInto }, '併入既有試卷'),
          el('button', {
            class: 'btn', onclick: () => UI.download('paper.json', JSON.stringify(r.paper, null, 2)),
          }, '下載 JSON')) : null);
    }

    async function save() {
      if (!staged) return;
      const title = prompt('試卷名稱', staged.title || '新試卷');
      if (!title) return;
      staged.title = title;
      try {
        const r = await API.post('/tests', { paper: staged, published: false });
        await warnIfMissingMedia(r.warnings);
        toast('已建立試卷', 'ok');
        location.hash = '#/admin/tests';
      } catch (e) { UI.alert(e.details?.errors?.join('\n') || e.message); }
    }

    async function mergeInto() {
      const { tests: list } = await API.get('/tests');
      const sel = el('select', {}, list.map((t) => el('option', { value: t.id }, t.title)));
      const ok = await UI.modal({
        title: '併入既有試卷', body: el('div', {}, el('p', {}, '選擇要併入的試卷：'), sel),
        actions: [{ label: '取消', value: false }, { label: '併入', class: 'primary', value: true }],
      });
      if (!ok) return;
      try {
        const merged = await API.post('/import/merge', { testId: Number(sel.value), paper: staged });
        await warnIfMissingMedia(merged.warnings);
        toast('已併入', 'ok'); location.hash = '#/admin/tests';
      } catch (e) { UI.alert(e.message); }
    }

    // ① JSON
    const jsonPane = el('div', {},
      el('p', { class: 'small muted' }, '上傳 .json 檔，或直接把 JSON 貼在下方。格式請參考範例檔（samples 資料夾）。'),
      el('input', { type: 'file', accept: '.json', onchange: async (e) => {
        const f = e.target.files[0]; if (!f) return;
        const fd = new FormData(); fd.append('file', f);
        try { showResult(await API.post('/import/json', fd)); } catch (er) { UI.alert(er.message); }
      } }),
      el('textarea', { id: 'json-text', rows: 8, placeholder: '{ "title": …, "modules": [...] }', style: { marginTop: '.7rem' } }),
      el('button', { class: 'btn', style: { marginTop: '.5rem' }, onclick: async () => {
        try { showResult(await API.post('/import/json', { paper: $('#json-text').value })); }
        catch (er) { UI.alert(er.message); }
      } }, '解析貼上的 JSON'));

    // ② Excel / CSV
    const xlsPane = el('div', {},
      el('p', { class: 'small muted' }, '一列一題，同題組填相同的 group 值。先下載範本比較快。'),
      el('a', { class: 'btn', href: `/api/import/template.xlsx?token=${API.token}` }, '⬇ 下載 Excel 範本'),
      el('div', { class: 'row', style: { marginTop: '.9rem' } },
        el('label', { class: 'field' }, el('span', {}, '試卷名稱'), el('input', { id: 'x-title', type: 'text', placeholder: '例：劍橋 18 Test 1' })),
        el('label', { class: 'field' }, el('span', {}, '類型'),
          el('select', { id: 'x-type' }, el('option', { value: 'academic' }, 'Academic'), el('option', { value: 'general' }, 'General Training')))),
      el('input', { type: 'file', accept: '.xlsx,.xls,.csv', onchange: async (e) => {
        const f = e.target.files[0]; if (!f) return;
        const fd = new FormData();
        fd.append('file', f);
        fd.append('title', $('#x-title').value || f.name.replace(/\.\w+$/, ''));
        fd.append('testType', $('#x-type').value);
        try { showResult(await API.post('/import/spreadsheet', fd)); } catch (er) { UI.alert(er.message); }
      } }));

    // ③ 貼上 + AI 解析
    const pastePane = el('div', {},
      el('p', { class: 'small muted' }, '把 Word / PDF 複製出來的題目直接貼進來，AI 會判斷題型並轉成系統格式。轉完請務必人工檢查。'),
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', {}, '這是哪一科'),
          el('select', { id: 'p-mod' },
            el('option', { value: '' }, '讓 AI 自己判斷'),
            el('option', { value: 'listening' }, 'Listening'),
            el('option', { value: 'reading' }, 'Reading'),
            el('option', { value: 'writing' }, 'Writing'),
            el('option', { value: 'speaking' }, 'Speaking'))),
        el('label', { class: 'field' }, el('span', {}, '試卷名稱'), el('input', { id: 'p-title', type: 'text' }))),
      el('label', { class: 'field' }, el('span', {}, '題目原文（含文章／指示語）'),
        el('textarea', { id: 'p-text', rows: 12, placeholder: 'READING PASSAGE 1\n\nYou should spend about 20 minutes…' })),
      el('label', { class: 'field' }, el('span', {}, '答案卷（選填，一行一題或 1. B 這種格式都可以）'),
        el('textarea', { id: 'p-key', rows: 5 })),
      el('button', { class: 'btn primary', onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = 'AI 解析中…（可能要 30 秒）';
        try {
          showResult(await API.post('/import/parse', {
            text: $('#p-text').value, answerKey: $('#p-key').value,
            moduleHint: $('#p-mod').value, title: $('#p-title').value,
          }));
        } catch (er) { UI.alert(er.message); }
        e.target.disabled = false; e.target.textContent = '交給 AI 解析';
      } }, '交給 AI 解析'));

    // ④ 媒體
    const mediaPane = el('div', { id: 'media-pane' });
    loadMedia(mediaPane);

    const panes = { json: jsonPane, xls: xlsPane, paste: pastePane, media: mediaPane };
    const holder = el('div', {}, jsonPane);
    const bar = el('div', { class: 'tabs' },
      [['json', 'JSON 檔'], ['xls', 'Excel / CSV'], ['paste', '貼上原文 + AI 解析'], ['media', '媒體庫（音檔／圖片）']]
        .map(([k, label], i) => el('button', {
          class: i === 0 ? 'active' : '',
          onclick: (e) => {
            [...bar.children].forEach((c) => c.classList.remove('active'));
            e.target.classList.add('active');
            UI.render(holder, panes[k]);
          },
        }, label)));

    UI.render(mount, 
      el('h2', {}, '匯入題目'),
      bar,
      el('div', { class: 'card' }, holder),
      out);
  }

  async function loadMedia(pane) {
    const render = async () => {
      const { media } = await API.get('/media');
      UI.render(pane, 
        el('p', { class: 'small muted' }, '上傳後把「網址」欄的路徑貼到題目的 audio / image 欄位即可。'),
        el('input', {
          type: 'file', multiple: true, accept: 'audio/*,image/*',
          onchange: async (e) => {
            const fd = new FormData();
            [...e.target.files].forEach((f) => fd.append('files', f));
            try { await API.post('/media', fd); toast('上傳完成', 'ok'); render(); }
            catch (er) { UI.alert(er.message); }
          },
        }),
        el('table', { class: 'data', style: { marginTop: '1rem' } },
          el('thead', {}, el('tr', {}, el('th', {}, '檔名'), el('th', {}, '類型'), el('th', {}, '網址'), el('th', {}, '預覽'), el('th', {}, ''))),
          el('tbody', {}, media.map((m) => el('tr', {},
            el('td', { class: 'small' }, m.name),
            el('td', {}, el('span', { class: 'pill' }, m.kind)),
            el('td', {}, el('code', { class: 'small', style: { cursor: 'pointer' }, onclick: () => { navigator.clipboard?.writeText(m.url); toast('已複製網址', 'ok'); } }, m.url)),
            el('td', {}, m.kind === 'audio'
              ? el('audio', { controls: true, src: m.url, style: { height: '30px', maxWidth: '200px' } })
              : el('img', { src: m.url, style: { maxHeight: '46px', borderRadius: '3px' } })),
            el('td', {}, el('button', {
              class: 'btn sm danger',
              onclick: async () => { await API.del(`/media/${m.id}`); render(); },
            }, '刪除')))))));
    };
    render();
  }

  // ── AI 出題 ─────────────────────────────────────────────
  async function generate(mount) {
    const { types } = await API.get('/tests/question-types');
    const objectiveTypes = Object.entries(types).filter(([, v]) => v.objective);

    const f = {};
    const result = el('div', { class: 'card' }, el('p', { class: 'muted' }, '產生結果會顯示在這裡。'));

    const single = el('div', {},
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', {}, '科目'),
          (f.module = el('select', {},
            el('option', { value: 'listening' }, 'Listening'),
            el('option', { value: 'reading', selected: true }, 'Reading')))),
        el('label', { class: 'field' }, el('span', {}, '題型'),
          (f.type = el('select', {}, objectiveTypes.map(([k, v]) => el('option', { value: k }, v.label))))),
        el('label', { class: 'field' }, el('span', {}, '題數'), (f.count = el('input', { type: 'number', value: 6, min: 1, max: 14 })))),
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', {}, '主題'), (f.topic = el('input', { type: 'text', placeholder: '例：都市綠化、遠距工作、海洋塑膠' }))),
        el('label', { class: 'field' }, el('span', {}, '難度'),
          (f.difficulty = el('select', {},
            el('option', { value: 'band 5-6' }, 'Band 5–6'),
            el('option', { value: 'band 6-7', selected: true }, 'Band 6–7'),
            el('option', { value: 'band 7-8' }, 'Band 7–8'),
            el('option', { value: 'band 8-9' }, 'Band 8–9')))),
        el('label', { class: 'field' }, el('span', {}, '起始題號'), (f.startNumber = el('input', { type: 'number', value: 1, min: 1 })))),
      el('label', { class: 'field' },
        el('span', {}, el('input', { type: 'checkbox', id: 'withPassage', checked: true, class: 'check' }), '同時產生文章／聽力逐字稿')),
      el('label', { class: 'field' }, el('span', {}, '已有文章或逐字稿？貼在這裡（AI 會只依這段內容出題）'),
        (f.passage = el('textarea', { rows: 5 }))),
      el('label', { class: 'field' }, el('span', {}, '額外要求'), (f.extra = el('input', { type: 'text', placeholder: '例：至少 2 題是 NOT GIVEN' }))),
      el('button', {
        class: 'btn primary',
        onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'AI 出題中…';
          try {
            const body = {
              module: f.module.value, type: f.type.value, count: Number(f.count.value),
              topic: f.topic.value, difficulty: f.difficulty.value,
              startNumber: Number(f.startNumber.value),
              withPassage: $('#withPassage').checked,
              extra: f.extra.value,
            };
            if (f.passage.value.trim()) {
              if (body.module === 'listening') body.transcript = f.passage.value;
              else body.passage = f.passage.value;
              body.withPassage = false;
            }
            const r = await API.post('/ai/generate', body);
            showGenerated(r, body);
          } catch (er) { UI.alert(er.message); }
          e.target.disabled = false; e.target.textContent = '產生題目';
        },
      }, '產生題目'));

    const wholeF = {};
    // ── 出題難度 ────────────────────────────────────────
    // 只選一個整體難度就能用；要細調再展開。四個微調預設「跟隨難度」，
    // 所以不碰的人拿到的就是這個 Band 的官方標準組合。
    const diffBox = el('div');
    const dF = { perModule: {}, knobs: {} };
    let diffMeta = null;

    function readDifficulty() {
      if (!diffMeta) return {};
      const perModule = {};
      for (const [m, sel] of Object.entries(dF.perModule)) if (sel.value) perModule[m] = sel.value;
      const knobs = {};
      for (const [k, sel] of Object.entries(dF.knobs)) knobs[k] = sel.value;
      return { level: dF.level.value, perModule, knobs };
    }

    async function refreshDiffPreview() {
      if (!diffMeta) return;
      const d = readDifficulty();
      try {
        const r = await API.get('/ai/difficulty?' + new URLSearchParams({
          testType: wholeF.testType.value,
          level: d.level,
          perModule: JSON.stringify(d.perModule),
          knobs: JSON.stringify(d.knobs),
        }));
        UI.render(dPreview, Object.entries(r.describe).map(([m, text]) =>
          el('div', { class: 'diff-line' },
            el('span', { class: 'diff-mod' }, UI.MODULE_LABEL[m]?.split(' ')[0] || m),
            el('span', {}, text),
            r.resolved.modules[m]?.overridden ? el('span', { class: 'pill' }, '單獨指定') : null)));
      } catch { /* 預覽失敗不影響出題 */ }
    }

    const dPreview = el('div', { class: 'diff-preview' });

    (async () => {
      let meta;
      try { meta = await API.get('/ai/difficulty'); } catch { return; }
      diffMeta = meta;
      const levelOpts = (sel, blank) => [
        blank ? el('option', { value: '' }, blank) : null,
        ...Object.entries(meta.levels).map(([k, v]) =>
          el('option', { value: k, selected: !blank && k === sel }, v.label)),
      ];

      dF.level = el('select', {}, levelOpts(meta.defaultLevel));
      dF.level.onchange = refreshDiffPreview;

      const modRow = el('div', { class: 'row' }, ['listening', 'reading', 'writing', 'speaking'].map((m) => {
        const sel = el('select', {}, levelOpts(null, '跟隨整體'));
        sel.onchange = refreshDiffPreview;
        dF.perModule[m] = sel;
        return el('label', { class: 'field' },
          el('span', {}, UI.MODULE_LABEL[m]?.split(' ')[0] || m), sel);
      }));

      const knobRow = el('div', { class: 'row' }, Object.entries(meta.knobs).map(([k, v]) => {
        const sel = el('select', {}, Object.entries(v.options).map(([ok, ov]) =>
          el('option', { value: ok, selected: ok === 'auto' }, ov.label)));
        sel.onchange = refreshDiffPreview;
        dF.knobs[k] = sel;
        return el('label', { class: 'field' },
          el('span', {}, v.label), sel,
          el('span', { class: 'small muted' }, v.zh));
      }));

      UI.render(diffBox,
        el('div', { class: 'row' },
          el('label', { class: 'field' },
            el('span', {}, '出題難度'), dF.level,
            el('span', { class: 'small muted' },
              '影響文章長度、句子複雜度、生難字比例與推論題多寡'))),
        el('details', {},
          el('summary', {}, '各科單獨指定難度'),
          el('div', { style: { paddingTop: '.6rem' } },
            el('p', { class: 'small muted' }, '留「跟隨整體」就用上面那個難度。班上聽力特別弱的話可以只把聽力調低。'),
            modRow)),
        el('details', {},
          el('summary', {}, '進階微調'),
          el('div', { style: { paddingTop: '.6rem' } },
            el('p', { class: 'small muted' }, '每一項預設「跟隨難度」，也就是這個 Band 的官方標準組合。要偏離再改。'),
            knobRow)),
        el('div', { class: 'small muted', style: { marginTop: '.2rem' } }, '這個設定會產出：'),
        dPreview);
      if (wholeF.testType) wholeF.testType.onchange = refreshDiffPreview;
      refreshDiffPreview();
    })();

    const startBtn = el('button', { class: 'btn primary' }, '產生完整試卷');
    const whole = el('div', {},
      el('p', { class: 'small muted' },
        '一次產生四科完整試卷（40+40 題、兩篇寫作、完整口說）。分成 9 段依序產生，'
        + '整份大約 3–8 分鐘，相當耗用 API 額度。'),
      el('p', { class: 'small muted' },
        '產生過程在伺服器上跑，', el('b', {}, '可以關掉頁面'),
        '，稍後回到這一頁會自動接回進度。'),
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', {}, '類型'),
          (wholeF.testType = el('select', {}, el('option', { value: 'academic' }, 'Academic'), el('option', { value: 'general' }, 'General Training')))),
        el('label', { class: 'field' }, el('span', {}, '主題風格'), (wholeF.theme = el('input', { type: 'text', placeholder: '例：環境與科技' })))),
      diffBox,
      startBtn);

    startBtn.onclick = async () => {
      startBtn.disabled = true;
      try {
        const r = await API.post('/ai/generate-paper', {
          testType: wholeF.testType.value, theme: wholeF.theme.value,
          difficulty: readDifficulty(),
        });
        watchJob(r.jobId);
      } catch (er) {
        startBtn.disabled = false;
        // 409：已經有一個在跑，直接接上去就好
        if (er.details?.jobId) watchJob(er.details.jobId);
        else UI.alert(er.message);
      }
    };

    // ── 背景工作進度 ──────────────────────────────────────
    const STEP_NAMES = [
      '聽力 Section 1', '聽力 Section 2', '聽力 Section 3', '聽力 Section 4',
      '閱讀 Passage 1', '閱讀 Passage 2', '閱讀 Passage 3', '寫作 Task 1+2', '口說 Part 1-3',
    ];

    function stopWatching() { clearInterval(jobTimer); jobTimer = null; }
    stopWatching();   // 重進頁面時先把上一次的輪詢收掉

    function watchJob(jobId) {
      stopWatching();
      startBtn.disabled = true;
      const tick = async () => {
        let job;
        try { ({ job } = await API.get(`/ai/jobs/${jobId}`)); }
        catch (e) { stopWatching(); startBtn.disabled = false; UI.alert(e.message); return; }
        renderJob(job);
        if (['done', 'error', 'cancelled'].includes(job.status)) {
          stopWatching();
          startBtn.disabled = false;
        }
      };
      tick();
      jobTimer = setInterval(tick, 2500);
    }

    function renderJob(job) {
      const pct = Math.max(0, Math.min(100, job.percent || 0));
      const bar = el('div', {
        style: {
          height: '10px', background: '#eceff1', borderRadius: '6px',
          overflow: 'hidden', margin: '.5rem 0',
        },
      }, el('div', {
        style: {
          height: '100%', width: `${pct}%`,
          background: job.status === 'error' ? 'var(--err)' : 'var(--brand)',
          transition: 'width .4s ease',
        },
      }));

      const checklist = el('ol', { class: 'small', style: { lineHeight: '1.9', paddingLeft: '1.3rem', margin: '.4rem 0' } },
        STEP_NAMES.map((name, i) => {
          const done = i < job.doneSteps;
          const current = i === job.doneSteps && job.status === 'running';
          return el('li', { style: { color: done ? 'var(--ok)' : current ? 'var(--ink)' : 'var(--muted)' } },
            done ? '✓ ' : current ? '▶ ' : '· ', name,
            current ? el('span', { class: 'muted' }, ' …產生中') : null);
        }));

      if (job.status === 'done') {
        const r = job.result || {};
        UI.render(result,
          el('h3', {}, r.ok ? '✅ 產生完成' : '⚠️ 產生完成，但有格式問題需要處理'),
          el('p', { class: 'small muted' },
            `聽力 ${r.stats?.listening || 0} 題　閱讀 ${r.stats?.reading || 0} 題　`
            + `寫作 ${r.stats?.writingTasks || 0} 篇　口說 ${r.stats?.speakingParts || 0} 部分`),
          r.issues?.length ? el('div', { class: 'small', style: { color: 'var(--warn)' } },
            el('b', {}, '有段落沒產生成功，存成試卷後請自行補上：'),
            el('ul', {}, r.issues.map((x) => el('li', {}, x)))) : null,
          r.errors?.length ? el('ul', { class: 'small' }, r.errors.map((x) => el('li', { style: { color: 'var(--err)' } }, x))) : null,
          r.warnings?.length ? el('ul', { class: 'small' }, r.warnings.map((x) => el('li', { class: 'muted' }, x))) : null,
          el('div', { style: { display: 'flex', gap: '.5rem', marginTop: '.6rem' } },
            el('button', {
              class: 'btn primary',
              onclick: async (e) => {
                e.target.disabled = true;
                try {
                  const saved = await API.post('/tests', { paper: r.paper, published: false });
                  await warnIfMissingMedia(saved.warnings);
                  toast('已存成試卷', 'ok'); location.hash = '#/admin/tests';
                } catch (er) {
                  e.target.disabled = false;
                  UI.alert(er.details?.errors?.join('\n') || er.message);
                }
              },
            }, '存成試卷'),
            el('button', { class: 'btn', onclick: () => UI.download('ai-paper.json', JSON.stringify(r.paper, null, 2)) }, '下載 JSON')));
        return;
      }

      if (job.status === 'error' || job.status === 'cancelled') {
        UI.render(result,
          el('h3', {}, job.status === 'cancelled' ? '已取消' : '❌ 產生失敗'),
          bar,
          job.error ? el('p', { class: 'small', style: { color: 'var(--err)', whiteSpace: 'pre-wrap' } }, job.error) : null,
          checklist,
          job.doneSteps > 0
            ? el('p', { class: 'small muted' },
                `已經完成 ${job.doneSteps} 段。可以按「取回已完成的部分」把它們存成一份不完整的試卷，再手動補齊。`)
            : null,
          el('div', { style: { display: 'flex', gap: '.5rem', marginTop: '.6rem' } },
            job.doneSteps > 0 ? el('button', {
              class: 'btn',
              onclick: async (e) => {
                e.target.disabled = true;
                try {
                  const { job: full } = await API.get(`/ai/jobs/${job.id}?partial=1`);
                  if (!full.partial) { UI.alert('這個工作沒有留下可用的半成品。'); e.target.disabled = false; return; }
                  const saved = await API.post('/tests', { paper: full.partial, published: false });
                  await warnIfMissingMedia(saved.warnings);
                  toast('已存成草稿試卷', 'ok'); location.hash = '#/admin/tests';
                } catch (er) {
                  e.target.disabled = false;
                  UI.alert(er.details?.errors?.join('\n') || er.message);
                }
              },
            }, '取回已完成的部分') : null,
            el('button', { class: 'btn primary', onclick: () => startBtn.click() }, '重新產生')));
        return;
      }

      UI.render(result,
        el('h3', {}, '產生中…'),
        el('p', { class: 'small muted' }, job.step || '準備中', `　（${pct}%）`),
        bar,
        checklist,
        el('p', { class: 'small muted' },
          '這件事在伺服器上跑，關掉頁面也不會中斷。回到這一頁會自動接回進度。'),
        el('button', {
          class: 'btn sm',
          onclick: async () => {
            if (!await UI.confirm('確定要取消？已經產生的段落會保留，可以取回。')) return;
            await API.post(`/ai/jobs/${job.id}/cancel`, {});
            toast('已送出取消', 'ok');
          },
        }, '取消'));
    }

    /** 接回進行中的工作時，順手把分頁切到「整份試卷」，
        免得畫面上顯示的是全卷進度、分頁卻停在「單一題組」。 */
    function showWholeTab() {
      const btn = bar?.children?.[1];
      if (btn && !btn.classList.contains('active')) btn.click();
    }

    // 進頁面時如果已經有工作在跑（或剛跑完），直接接回去
    (async () => {
      try {
        const { jobs: list } = await API.get('/ai/jobs?kind=generate_paper');
        const live = list.find((j) => j.status === 'running' || j.status === 'queued');
        if (live) {
          showWholeTab();
          toast('接回正在進行的試卷產生工作', 'ok');
          watchJob(live.id);
        } else if (list[0] && list[0].status === 'done') {
          showWholeTab();
          const { job } = await API.get(`/ai/jobs/${list[0].id}`);
          renderJob(job);
        }
      } catch { /* 沒有就算了 */ }
    })();

    function showGenerated(r, body) {
      const group = r.group;
      UI.render(result, 
        el('h3', {}, '產生結果'),
        r.passageTitle && el('p', {}, el('b', {}, r.passageTitle)),
        r.passage && el('details', {}, el('summary', { class: 'small muted' }, '文章'),
          el('div', { class: 'passage', html: sanitize(r.passage) })),
        r.transcript && el('details', {}, el('summary', { class: 'small muted' }, '聽力逐字稿'),
          el('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '.85rem' } }, r.transcript)),
        el('div', { class: 'rubric small' }, group?.instructions || ''),
        UI.dataTable(
          el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, '題目'), el('th', {}, '答案'), el('th', {}, '解析'))),
          el('tbody', {}, (group?.questions || []).map((q) => el('tr', {},
            el('td', {}, String(q.number)),
            el('td', { class: 'small' }, q.text || '(填空)'),
            el('td', {}, el('b', {}, (q.answers || []).join(' / '))),
            el('td', { class: 'small muted' }, q.explanation || ''))))),
        el('div', { style: { display: 'flex', gap: '.5rem', marginTop: '.8rem' } },
          el('button', {
            class: 'btn primary',
            onclick: async () => {
              // 老師自己貼的文章／逐字稿一定要跟著存進去，
              // 否則學生端只會看到題目、左邊一片空白
              const paper = {
                title: `AI 題組 — ${body.topic || group.type}`,
                testType: 'academic',
                modules: [{
                  module: body.module,
                  sections: [{
                    title: body.module === 'reading' ? 'Reading Passage 1' : 'Section 1',
                    passageTitle: r.passageTitle,
                    passage: r.passage || body.passage || null,
                    transcript: r.transcript || body.transcript || null,
                    groups: [group],
                  }],
                }],
              };
              try {
                const saved = await API.post('/tests', { paper, published: false });
                await warnIfMissingMedia(saved.warnings);
                toast('已存成新試卷', 'ok'); location.hash = '#/admin/tests';
              } catch (er) { UI.alert(er.details?.errors?.join('\n') || er.message); }
            },
          }, '存成新試卷'),
          el('button', {
            class: 'btn',
            onclick: async (e) => {
              await API.post('/ai/bank', {
                module: body.module, type: body.type, topic: body.topic, difficulty: body.difficulty,
                payload: {
                  group,
                  passage: r.passage || body.passage || null,
                  transcript: r.transcript || body.transcript || null,
                  passageTitle: r.passageTitle || null,
                },
              });
              toast('已存進題庫，可在左上「題庫」頁面找到', 'ok');
              e.target.replaceWith(el('a', { class: 'btn', href: '#/admin/bank' }, '前往題庫 →'));
            },
          }, '存進題庫'),
          el('button', { class: 'btn', onclick: () => UI.download('group.json', JSON.stringify(r, null, 2)) }, '下載 JSON')));
    }

    const holder = el('div', {}, single);
    const bar = el('div', { class: 'tabs' },
      [['單一題組', single], ['整份試卷', whole]].map(([label, pane], i) =>
        el('button', {
          class: i === 0 ? 'active' : '',
          onclick: (e) => {
            [...bar.children].forEach((c) => c.classList.remove('active'));
            e.target.classList.add('active');
            UI.render(holder, pane);
          },
        }, label)));

    UI.render(mount, 
      el('h2', {}, 'AI 出題'),
      el('p', { class: 'small muted' }, 'AI 產生的題目請務必人工校對後再使用。'),
      bar, el('div', { class: 'card' }, holder), result);
  }

  // ══ 成員管理（學生 / 老師 / 管理員）══════════════════════
  const ROLE_LABEL = { admin: '管理員', teacher: '老師', student: '學生' };
  const ROLE_PILL = { admin: 'err', teacher: 'info', student: '' };

  async function members(mount) {
    const filter = { role: '', q: '', classGroup: '', active: '' };
    const selected = new Set();
    const me = API.user;
    const isAdmin = me?.role === 'admin';

    const box = el('div');
    const counter = el('span', { class: 'small muted' });
    const roleTabs = el('div', { class: 'tabs' });

    async function load() {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(filter)) if (v) qs.set(k, v);
      const d = await API.get(`/users?${qs}`);

      const s = d.summary || {};
      const total = (r) => (s[r] ? `${s[r].active}/${s[r].total}` : '0');
      counter.textContent =
        `管理員 ${total('admin')}　老師 ${total('teacher')}　學生 ${total('student')}　（啟用/總數）`;

      UI.render(roleTabs, [['', '全部'], ['admin', '管理員'], ['teacher', '老師'], ['student', '學生']]
        .map(([v, label]) => el('button', {
          class: filter.role === v ? 'active' : '',
          onclick: () => { filter.role = v; selected.clear(); load(); },
        }, label)));

      UI.render(box, d.users.length === 0
        ? el('div', { class: 'empty' }, '沒有符合條件的成員。')
        : UI.dataTable(
            el('thead', {}, el('tr', {},
              el('th', {}, el('input', {
                type: 'checkbox',
                onchange: (e) => {
                  selected.clear();
                  if (e.target.checked) d.users.forEach((u) => { if (u.id !== me.id) selected.add(u.id); });
                  load();
                },
              })),
              el('th', {}, '姓名 / 帳號'), el('th', {}, '角色'), el('th', {}, '班級'),
              el('th', {}, '考試紀錄'), el('th', {}, '狀態'), el('th', {}, ''))),
            el('tbody', {}, d.users.map((u) => {
              const self = u.id === me.id;
              const canTouch = isAdmin || u.role === 'student';
              return el('tr', { style: u.active ? {} : { opacity: '.55' } },
                el('td', {}, el('input', {
                  type: 'checkbox', checked: selected.has(u.id), disabled: self || !canTouch,
                  title: self ? '不能對自己批次操作' : '',
                  onchange: (e) => { e.target.checked ? selected.add(u.id) : selected.delete(u.id); },
                })),
                el('td', {},
                  el('b', {}, u.name),
                  self ? el('span', { class: 'pill info', style: { marginLeft: '.4rem' } }, '這是你') : null,
                  el('div', { class: 'small muted' }, u.username, u.email ? ` · ${u.email}` : '')),
                el('td', {}, el('span', { class: `pill ${ROLE_PILL[u.role]}` }, ROLE_LABEL[u.role] || u.role)),
                el('td', { class: 'small' }, u.class_group || '—',
                  u.candidate_no ? el('div', { class: 'small muted' }, `編號 ${u.candidate_no}`) : null),
                el('td', { class: 'small' },
                  Number(u.attempts) > 0
                    ? el('a', { href: `#/admin/data` }, `${u.attempts} 場`)
                    : el('span', { class: 'muted' }, '—')),
                el('td', {}, u.active
                  ? el('span', { class: 'pill ok' }, '啟用')
                  : el('span', { class: 'pill' }, '已停用')),
                el('td', { style: { whiteSpace: 'nowrap' } },
                  canTouch ? el('button', { class: 'btn sm', onclick: () => editMember(u, mount) }, '編輯') : null,
                  ' ',
                  canTouch ? el('button', {
                    class: 'btn sm',
                    onclick: async () => {
                      const p = prompt(`為「${u.name}」設定新密碼（至少 6 字元）`);
                      if (!p) return;
                      try { await API.put(`/users/${u.id}`, { password: p }); toast('密碼已更新', 'ok'); }
                      catch (e) { UI.alert(e.message); }
                    },
                  }, '重設密碼') : null,
                  ' ',
                  canTouch && !self ? el('button', {
                    class: 'btn sm',
                    onclick: async () => {
                      try {
                        await API.put(`/users/${u.id}`, { active: !u.active });
                        toast(u.active ? '已停用' : '已啟用', 'ok'); load();
                      } catch (e) { UI.alert(e.message); }
                    },
                  }, u.active ? '停用' : '啟用') : null,
                  ' ',
                  isAdmin && !self ? el('button', {
                    class: 'btn sm danger', onclick: () => removeMember(u, load),
                  }, '刪除') : null));
            }))));
    }

    UI.render(mount,
      el('div', { class: 'toolbar' },
        el('h2', { style: { margin: 0 } }, '成員管理'),
        el('span', { style: { flex: 1 } }),
        counter),

      el('div', { class: 'card' },
        roleTabs,
        el('div', { class: 'toolbar' },
          el('input', {
            type: 'text', placeholder: '搜尋姓名／帳號／Email／考生編號', style: { maxWidth: '260px' },
            oninput: UI.debounce((e) => { filter.q = e.target.value; load(); }, 350),
          }),
          el('select', { onchange: (e) => { filter.active = e.target.value; load(); } },
            el('option', { value: '' }, '啟用與停用都顯示'),
            el('option', { value: '1' }, '只看啟用中'),
            el('option', { value: '0' }, '只看已停用')),
          el('span', { style: { flex: 1 } }),
          el('button', { class: 'btn', onclick: () => bulkAddStudents(mount) }, '批次新增學生'),
          el('button', { class: 'btn primary', onclick: () => editMember(null, mount) }, '＋ 新增成員')),

        el('div', { class: 'toolbar' },
          el('span', { class: 'small muted' }, '勾選後可批次處理：'),
          el('button', {
            class: 'btn sm',
            onclick: () => bulkAction('activate', '啟用', selected, load),
          }, '啟用'),
          el('button', {
            class: 'btn sm',
            onclick: () => bulkAction('deactivate', '停用', selected, load),
          }, '停用'),
          isAdmin ? el('button', {
            class: 'btn sm danger',
            onclick: () => bulkAction('delete', '刪除', selected, load),
          }, '刪除') : null),

        box,

        el('p', { class: 'small muted', style: { marginTop: '.8rem' } },
          isAdmin
            ? '「停用」保留所有資料，只是不能登入，隨時可以再啟用 —— 學生畢業或老師離職建議用停用。「刪除」會連同這個人的所有考試紀錄、作文與口說錄音一起移除，無法復原。'
            : '你是老師，可以管理學生；老師與管理員帳號的新增、修改、刪除只有管理員能做。')));

    load();
  }

  /** 新增或編輯一位成員 */
  async function editMember(u, mount) {
    const isAdmin = API.user?.role === 'admin';
    const isSelf = u && u.id === API.user?.id;
    const f = {};

    const roleSel = el('select', { disabled: !isAdmin || isSelf },
      el('option', { value: 'student', selected: !u || u.role === 'student' }, '學生'),
      el('option', { value: 'teacher', selected: u?.role === 'teacher' }, '老師'),
      el('option', { value: 'admin', selected: u?.role === 'admin' }, '管理員'));
    f.role = roleSel;

    const studentFields = el('div', {},
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', {}, '班級'),
          (f.classGroup = el('input', { type: 'text', value: u?.class_group || '' }))),
        el('label', { class: 'field' }, el('span', {}, '考生編號'),
          (f.candidateNo = el('input', { type: 'text', value: u?.candidate_no || '' })))),
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', {}, '出生日期'),
          (f.dateOfBirth = el('input', { type: 'date', value: u?.date_of_birth || '' }))),
        el('label', { class: 'field' }, el('span', {}, '國籍'),
          (f.nationality = el('input', { type: 'text', value: u?.nationality || '' })))));

    const syncRoleFields = () => {
      studentFields.style.display = roleSel.value === 'student' ? '' : 'none';
    };
    roleSel.addEventListener('change', syncRoleFields);

    const body = el('div', {},
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', {}, '姓名 *'),
          (f.name = el('input', { type: 'text', value: u?.name || '' }))),
        el('label', { class: 'field' }, el('span', {}, '角色'),
          roleSel,
          !isAdmin ? el('span', { class: 'small muted' }, '只有管理員能指定老師或管理員')
            : isSelf ? el('span', { class: 'small muted' }, '不能改自己的角色') : null)),
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', {}, '帳號 *'),
          (f.username = el('input', { type: 'text', value: u?.username || '', disabled: u && !isAdmin }))),
        el('label', { class: 'field' }, el('span', {}, u ? '新密碼（不改就留空）' : '密碼 *'),
          (f.password = el('input', { type: 'text', value: u ? '' : 'ielts1234' })))),
      el('label', { class: 'field' }, el('span', {}, 'Email（選填）'),
        (f.email = el('input', { type: 'email', value: u?.email || '' }))),
      studentFields);
    syncRoleFields();

    const ok = await UI.modal({
      title: u ? `編輯成員：${u.name}` : '新增成員', width: '640px', body,
      actions: [{ label: '取消', value: false }, { label: '儲存', class: 'primary', value: true }],
    });
    if (!ok) return;

    const payload = {
      name: f.name.value.trim(),
      email: f.email.value.trim(),
      role: roleSel.value,
      classGroup: f.classGroup.value.trim(),
      candidateNo: f.candidateNo.value.trim(),
      dateOfBirth: f.dateOfBirth.value || null,
      nationality: f.nationality.value.trim(),
    };
    if (!payload.name) return UI.alert('請填姓名');
    if (f.password.value) payload.password = f.password.value;

    try {
      if (u) {
        if (isAdmin) payload.username = f.username.value.trim();
        await API.put(`/users/${u.id}`, payload);
      } else {
        if (!f.username.value.trim()) return UI.alert('請填帳號');
        if (!f.password.value) return UI.alert('請填密碼');
        payload.username = f.username.value.trim();
        await API.post('/users', payload);
      }
      toast('已儲存', 'ok');
      members(mount);
    } catch (e) { UI.alert(e.message); }
  }

  /** 刪除一位成員（先問清楚會失去什麼） */
  async function removeMember(u, reload) {
    let impact = null;
    try { impact = await API.get(`/users/${u.id}/impact`); } catch { /* 拿不到就用保守說法 */ }

    const ok = await UI.modal({
      title: `刪除成員：${u.name}`,
      body: el('div', {},
        el('p', {}, '確定要刪除 ', el('b', {}, `${u.name}（${u.username}）`), ' 嗎？'),
        impact ? el('div', { class: 'card', style: { background: '#fdf7f6', borderColor: '#f0c8c2' } },
          el('p', { style: { margin: 0 } }, el('b', {}, '會一併永久刪除：')),
          el('ul', { style: { margin: '.4rem 0 0', lineHeight: '1.8' } },
            el('li', {}, `${impact.attempts} 場考試紀錄`,
              impact.attempts ? '（含逐題作答、作文、口說錄音）' : ''),
            el('li', {}, `${impact.assignments} 筆指派`)),
          impact.testsCreated
            ? el('p', { class: 'small', style: { marginBottom: 0 } },
                `他建立的 ${impact.testsCreated} 份試卷會保留，只是「建立者」欄位會變成空白。`)
            : null) : null,
        el('p', { class: 'small muted' },
          '如果只是學生畢業或老師離職，建議改用「停用」——資料會完整保留，隨時可以再啟用。')),
      actions: [
        { label: '取消', value: false },
        { label: '改用停用', value: 'deactivate' },
        { label: '確定永久刪除', class: 'danger', value: true },
      ],
    });

    if (ok === 'deactivate') {
      try { await API.put(`/users/${u.id}`, { active: false }); toast('已停用', 'ok'); reload(); }
      catch (e) { UI.alert(e.message); }
      return;
    }
    if (!ok) return;

    try {
      const r = await API.del(`/users/${u.id}`);
      toast(`已刪除，連同 ${r.deletedAttempts} 場考試紀錄`, 'ok');
      reload();
    } catch (e) { UI.alert(e.message); }
  }

  async function bulkAction(action, label, selected, reload) {
    if (!selected.size) return UI.alert('請先勾選成員');
    if (action === 'delete') {
      const ok = await UI.confirm(
        `確定要刪除這 ${selected.size} 位成員嗎？他們的所有考試紀錄也會一併移除，無法復原。`, '確定刪除');
      if (!ok) return;
    }
    try {
      const r = await API.post('/users/bulk-action', { action, ids: [...selected] });
      toast(`已${label} ${r.affected ?? r.deleted} 位成員`, 'ok');
    } catch (e) {
      if (e.details?.needsForce) {
        const ok = await UI.confirm(`${e.message}\n\n再次確認要刪除嗎？`, '仍要刪除');
        if (!ok) return;
        const r = await API.post('/users/bulk-action', { action, ids: [...selected], force: true });
        toast(`已刪除 ${r.deleted} 位成員`, 'ok');
      } else return UI.alert(e.message);
    }
    selected.clear();
    reload();
  }

  /** 批次貼名單建立學生 */
  async function bulkAddStudents(mount) {
    const ta = el('textarea', { rows: 10, placeholder: '王小明,ming01,pass1234,A班,0001\n陳大文,wen02\n李美美' });
    const cls = el('input', { type: 'text', placeholder: '沒填班級的人統一放這班' });
    const ok = await UI.modal({
      title: '批次新增學生', width: '640px',
      body: el('div', {},
        el('p', { class: 'small muted' },
          '一行一位，格式：姓名, 帳號, 密碼, 班級, 考生編號。後面欄位可以省略；沒填帳號會自動產生，沒填密碼預設 ielts1234。'),
        el('label', { class: 'field' }, el('span', {}, '預設班級'), cls),
        ta),
      actions: [{ label: '取消', value: false }, { label: '建立', class: 'primary', value: true }],
    });
    if (!ok) return;
    try {
      const r = await API.post('/users/bulk', { text: ta.value, classGroup: cls.value });
      await UI.alert(el('div', {},
        el('p', {}, `成功建立 ${r.created.length} 位。`),
        r.skipped.length ? el('p', { style: { color: 'var(--warn)' } }, `略過 ${r.skipped.length} 位：${r.skipped.join('、')}`) : null,
        UI.dataTable(
          el('thead', {}, el('tr', {}, el('th', {}, '姓名'), el('th', {}, '帳號'), el('th', {}, '密碼'))),
          el('tbody', {}, r.created.map((c) => el('tr', {}, el('td', {}, c.name), el('td', {}, c.username), el('td', {}, c.password))))),
        el('button', {
          class: 'btn sm', onclick: () => UI.download('students.csv',
            '﻿姓名,帳號,密碼,班級\n' + r.created.map((c) => `${c.name},${c.username},${c.password},${c.classGroup || ''}`).join('\n'), 'text/csv'),
        }, '下載帳密清單 CSV')), '建立結果');
      members(mount);
    } catch (e) { UI.alert(e.message); }
  }

  // ── 指派考試 ────────────────────────────────────────────
  async function assign(mount, params) {
    const [{ tests: list }, { users }, { classes }, { assignments }, presets] = await Promise.all([
      API.get('/tests'), API.get('/users?role=student'), API.get('/users/classes'),
      API.get('/tests/assignments/all'), API.get('/tests/exam-rules/presets'),
    ]);
    const MODS = ['listening', 'reading', 'writing', 'speaking'];

    const f = {};
    const studentBox = el('div', {
      style: { maxHeight: '220px', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '4px', padding: '.5rem' },
    }, users.map((u) => el('label', { style: { display: 'block', padding: '.15rem 0' } },
      el('input', { type: 'checkbox', value: u.id, class: 'check' }),
      `${u.name}（${u.username}）`, u.class_group ? el('span', { class: 'muted small' }, ` · ${u.class_group}`) : null)));

    UI.render(mount,
      el('div', { class: 'toolbar' },
        el('h2', { style: { margin: 0 } }, '指派考試'),
        el('span', { style: { flex: '1' } }),
        el('button', {
          class: 'btn',
          onclick: () => noticeDialog(users, classes),
        }, '📢 發通知給學生')),
      el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('label', { class: 'field' }, el('span', {}, '試卷'),
            (f.testId = el('select', {}, list.map((t) => el('option', { value: t.id, selected: String(t.id) === params?.test }, t.title))))),
          el('label', { class: 'field' }, el('span', {}, '指派給整個班級'),
            (f.classGroup = el('select', {}, el('option', { value: '' }, '（不指定）'),
              classes.map((c) => el('option', { value: c.name }, `${c.name}（${c.n} 人）`)))))),
        el('label', { class: 'field' }, el('span', {}, '或個別挑選學生'), studentBox),
        el('div', { class: 'row', style: { marginTop: '.8rem' } },
          el('label', { class: 'field' }, el('span', {}, '要考的科目'),
            (f.modules = el('select', {},
              el('option', { value: 'listening,reading,writing,speaking' }, '四科全考'),
              el('option', { value: 'listening,reading' }, '只考聽力＋閱讀'),
              el('option', { value: 'listening' }, '只考聽力'),
              el('option', { value: 'reading' }, '只考閱讀'),
              el('option', { value: 'writing' }, '只考寫作'),
              el('option', { value: 'speaking' }, '只考口說')))),
          el('label', { class: 'field' }, el('span', {}, '寫作評分'),
            (f.writingGrading = el('select', {}, el('option', { value: 'ai' }, 'AI 自動批改'), el('option', { value: 'human' }, '老師人工批改')))),
          el('label', { class: 'field' }, el('span', {}, '口說評分'),
            (f.speakingGrading = el('select', {}, el('option', { value: 'ai' }, 'AI 自動評分'), el('option', { value: 'human' }, '老師人工評分'))))),
        el('div', { class: 'row' },
          el('label', { class: 'field' }, el('span', {}, '開放時間'), (f.openFrom = el('input', { type: 'datetime-local' }))),
          el('label', { class: 'field' }, el('span', {}, '截止時間'), (f.openUntil = el('input', { type: 'datetime-local' }))),
          el('label', { class: 'field' }, el('span', {}, '可考次數'), (f.maxAttempts = el('input', { type: 'number', value: 1, min: 1, max: 10 })))),
        // ── 考試時間 ────────────────────────────────────────
        el('details', { style: { marginBottom: '.8rem' } },
          el('summary', {}, el('b', {}, '⏱ 考試時間'),
            el('span', { class: 'small muted' }, '　留空 = 用試卷預設（官方時間）')),
          el('div', { style: { paddingTop: '.7rem' } },
            el('div', { class: 'row' }, MODS.map((m) => {
              const mins = Math.round((presets.officialDurations[m] || 0) / 60);
              return el('label', { class: 'field' },
                el('span', {}, `${UI.MODULE_LABEL[m].split(' ')[0]}（分鐘）`),
                (f[`dur_${m}`] = el('input', { type: 'number', min: 1, max: 300, placeholder: `官方 ${mins}` })));
            })),
            el('div', { class: 'row' },
              el('label', { class: 'field' },
                el('span', {}, '額外時間（%）'),
                (f.extraTimePct = el('input', { type: 'number', min: 0, max: 200, value: 0 })),
                el('span', { class: 'small muted' }, '無障礙加時。填 25 就是每一科都多 25%，會疊加在上面的設定之上')),
              el('div', { class: 'field' },
                el('span', {}, '快速設定'),
                el('div', { style: { display: 'flex', gap: '.4rem', flexWrap: 'wrap' } },
                  [['官方標準', 0], ['+25% 加時', 25], ['+50% 加時', 50]].map(([label, pct]) =>
                    el('button', {
                      class: 'btn sm', type: 'button',
                      onclick: () => {
                        MODS.forEach((m) => { f[`dur_${m}`].value = ''; });
                        f.extraTimePct.value = String(pct);
                        toast(pct ? `已套用 +${pct}% 加時` : '已回到官方標準時間', 'ok');
                      },
                    }, label)))))),

        // ── 休息流程 ────────────────────────────────────────
        el('details', { style: { marginBottom: '.8rem' } },
          el('summary', {}, el('b', {}, '☕ 科目之間的休息')),
          el('div', { style: { paddingTop: '.7rem' } },
            el('div', { class: 'row' },
              el('label', { class: 'field' }, el('span', {}, '休息政策'),
                (f.breakPolicy = el('select', {
                  onchange: (e) => { f._breakWrap.style.display = e.target.value === 'timed' ? '' : 'none'; },
                },
                  el('option', { value: 'flexible' }, '自由 — 學生自己決定何時開始下一科（預設）'),
                  el('option', { value: 'official' }, '官方流程 — 聽讀寫連續不中斷'),
                  el('option', { value: 'timed' }, '固定休息 — 每科之間休息幾分鐘')))),
              (f._breakWrap = el('label', { class: 'field', style: { display: 'none' } },
                el('span', {}, '休息幾分鐘'),
                (f.breakMinutes = el('input', { type: 'number', min: 1, max: 60, value: 10 })),
                el('span', { class: 'small muted' }, '倒數結束自動進入下一科')))),
            el('p', { class: 'small muted' },
              '雅思官方在聽力、閱讀、寫作之間是不安排休息的；口說一律獨立進行，不受這裡影響。'))),

        // ── 監考／反作弊 ────────────────────────────────────
        el('details', { style: { marginBottom: '.8rem' } },
          el('summary', {}, el('b', {}, '🔒 監考／反作弊')),
          el('div', { style: { paddingTop: '.7rem' } },
            el('label', { class: 'field' }, el('span', {},
              (f.procEnabled = el('input', {
                type: 'checkbox', class: 'check',
                onchange: (e) => { f._procWrap.style.display = e.target.checked ? '' : 'none'; },
              })),
              el('b', {}, '啟用監考模式'))),
            (f._procWrap = el('div', { style: { display: 'none', paddingLeft: '1.2rem' } },
              el('label', { class: 'field' }, el('span', {},
                (f.requireFullscreen = el('input', { type: 'checkbox', checked: true, class: 'check' })),
                '強制全螢幕作答（離開全螢幕會被要求回去並記錄）')),
              el('label', { class: 'field' }, el('span', {},
                (f.blockCopy = el('input', { type: 'checkbox', checked: true, class: 'check' })),
                '禁止複製題目內容、禁止把外部文字貼進作文')),
              el('label', { class: 'field' }, el('span', {},
                (f.warnOnLeave = el('input', { type: 'checkbox', checked: true, class: 'check' })),
                '切換分頁或離開視窗時立刻跳出警告')),
              el('div', { class: 'row' },
                el('label', { class: 'field' }, el('span', {}, '允許離開畫面幾次'),
                  (f.maxLeaves = el('input', { type: 'number', min: 0, max: 50, value: 0 })),
                  el('span', { class: 'small muted' }, '0 = 不設上限，只記錄不處置')),
                el('label', { class: 'field' }, el('span', {}, '超過上限時'),
                  (f.onExceed = el('select', {},
                    el('option', { value: 'warn' }, '只警告（建議）'),
                    el('option', { value: 'submit' }, '自動結束該科'))),
                  el('span', { class: 'small muted' }, '選「自動結束」前請三思：網路或瀏覽器出狀況也可能誤觸'))),
              el('p', { class: 'small muted' },
                '所有事件都會記錄，考完可以在成績頁的「考試紀律」看到完整時間軸。',
                el('br'),
                '這是瀏覽器端的防護，能擋掉大部分隨手作弊，但擋不了第二台裝置或手機。')))),

        el('button', {
          class: 'btn primary',
          onclick: async () => {
            const userIds = [...studentBox.querySelectorAll('input:checked')].map((i) => Number(i.value));
            if (!userIds.length && !f.classGroup.value) return UI.alert('請選擇班級或至少一位學生');

            const durationOverrides = {};
            for (const m of MODS) {
              const v = Number(f[`dur_${m}`].value);
              if (Number.isFinite(v) && v > 0) durationOverrides[m] = Math.round(v * 60);
            }
            const policy = f.breakPolicy.value;

            try {
              await API.post('/tests/assignments', {
                testId: Number(f.testId.value), userIds, classGroup: f.classGroup.value || null,
                modules: f.modules.value, writingGrading: f.writingGrading.value,
                speakingGrading: f.speakingGrading.value,
                openFrom: f.openFrom.value ? f.openFrom.value.replace('T', ' ') + ':00' : null,
                openUntil: f.openUntil.value ? f.openUntil.value.replace('T', ' ') + ':00' : null,
                maxAttempts: Number(f.maxAttempts.value),
                durationOverrides,
                extraTimePct: Number(f.extraTimePct.value) || 0,
                breakPolicy: policy,
                breakSeconds: policy === 'timed' ? (Number(f.breakMinutes.value) || 0) * 60 : 0,
                proctoring: f.procEnabled.checked ? {
                  enabled: true,
                  requireFullscreen: f.requireFullscreen.checked,
                  blockCopy: f.blockCopy.checked,
                  warnOnLeave: f.warnOnLeave.checked,
                  maxLeaves: Number(f.maxLeaves.value) || 0,
                  onExceed: f.onExceed.value,
                } : { enabled: false },
              });
              toast('已指派並自動發布試卷', 'ok');
              assign(mount, params);
            } catch (e) { UI.alert(e.message); }
          },
        }, '確認指派')),

      el('div', { class: 'card' },
        el('h3', {}, '已指派'),
        assignments.length === 0 ? el('p', { class: 'muted' }, '尚未指派任何考試。')
          : UI.dataTable(
              el('thead', {}, el('tr', {}, el('th', {}, '試卷'), el('th', {}, '對象'), el('th', {}, '科目'),
                el('th', {}, '評分'), el('th', {}, '考試規則'), el('th', {}, '期間'), el('th', {}, ''))),
              el('tbody', {}, assignments.map((a) => el('tr', {},
                el('td', {}, a.test_title),
                el('td', {}, a.class_group ? `班級：${a.class_group}` : a.student_name || '—'),
                el('td', { class: 'small' }, a.modules.split(',').map((m) => UI.MODULE_LABEL[m]?.split(' ')[0]).join('、')),
                el('td', { class: 'small' }, `寫作 ${a.writing_grading === 'ai' ? 'AI' : '人工'} / 口說 ${a.speaking_grading === 'ai' ? 'AI' : '人工'}`),
                el('td', { class: 'small' }, (() => {
                  const bits = [];
                  const ov = (() => { try { return JSON.parse(a.duration_overrides || 'null'); } catch { return null; } })();
                  if (ov) bits.push(Object.entries(ov).map(([m, s]) => `${UI.MODULE_LABEL[m]?.[0] || m}${Math.round(s / 60)}分`).join(' '));
                  if (Number(a.extra_time_pct) > 0) bits.push(`加時 +${a.extra_time_pct}%`);
                  const pr = (() => { try { return JSON.parse(a.proctoring || 'null'); } catch { return null; } })();
                  if (pr?.enabled) bits.push('🔒 監考');
                  if (a.break_policy === 'official') bits.push('官方連續');
                  if (a.break_policy === 'timed') bits.push(`休息 ${Math.round((a.break_seconds || 0) / 60)} 分`);
                  return bits.length ? bits.join('、') : el('span', { class: 'muted' }, '預設');
                })()),
                el('td', { class: 'small muted' }, a.open_from ? `${fmtDate(a.open_from)} ~ ${fmtDate(a.open_until)}` : '不限'),
                el('td', {}, el('button', {
                  class: 'btn sm danger',
                  onclick: async () => { await API.del(`/tests/assignments/${a.id}`); assign(mount, params); },
                }, '取消'))))))))));
  }

  /**
   * 發一則通知給學生。
   * 指派考試會自動通知，這裡是給「臨時改教室、記得帶耳機」這種臨時公告用的。
   */
  async function noticeDialog(users, classes) {
    const title = el('input', { type: 'text', placeholder: '例如：明天聽力考試改到電腦教室' });
    const body = el('textarea', { rows: 3, placeholder: '（選填）想多說的話寫在這裡' });
    const cls = el('select', {}, el('option', { value: '' }, '（不指定班級）'),
      classes.map((c) => el('option', { value: c.name }, `${c.name}（${c.n} 人）`)));
    const box = el('div', {
      style: {
        maxHeight: '200px', overflow: 'auto', border: '1px solid var(--line)',
        borderRadius: '4px', padding: '.5rem',
      },
    }, users.map((u) => el('label', { style: { display: 'block', padding: '.15rem 0' } },
      el('input', { type: 'checkbox', value: u.id, class: 'check' }),
      `${u.name}（${u.username}）`,
      u.class_group ? el('span', { class: 'muted small' }, ` · ${u.class_group}`) : null)));

    const count = el('span', { class: 'small muted' });
    const recount = () => {
      const n = box.querySelectorAll('input:checked').length;
      const c = classes.find((x) => x.name === cls.value);
      count.textContent = cls.value
        ? `會送給 ${cls.value} 全班${c ? ` ${c.n} 人` : ''}${n ? `，外加另外勾選的 ${n} 人` : ''}`
        : (n ? `會送給勾選的 ${n} 位學生` : '還沒選收件者');
    };
    box.addEventListener('change', recount);
    cls.addEventListener('change', recount);
    recount();

    const ok = await UI.modal({
      title: '發通知給學生',
      width: '620px',
      body: el('div', {},
        el('p', { class: 'small muted' },
          '會出現在學生右上角的鈴鐺。如果有設定 Email 通知，也會一起寄信給有填信箱的學生。'),
        el('label', { class: 'field' }, el('span', {}, '標題（必填）'), title),
        el('label', { class: 'field' }, el('span', {}, '內容'), body),
        el('label', { class: 'field' }, el('span', {}, '整個班級'), cls),
        el('label', { class: 'field' }, el('span', {}, '或個別挑選'), box),
        el('p', { style: { marginTop: '.5rem' } }, count)),
      actions: [
        { label: '取消', value: false },
        {
          label: '送出',
          class: 'primary',
          value: true,
          onClick: () => {
            if (!title.value.trim()) { toast('請填標題', 'warn'); return false; }
            if (!cls.value && !box.querySelector('input:checked')) { toast('請選收件者', 'warn'); return false; }
            return true;
          },
        },
      ],
    });
    if (!ok) return;

    try {
      const r = await API.post('/notifications/send', {
        title: title.value.trim(),
        body: body.value.trim() || null,
        classGroup: cls.value || null,
        userIds: [...box.querySelectorAll('input:checked')].map((i) => Number(i.value)),
      });
      toast(`通知已送給 ${r.sent} 位學生`, 'ok');
    } catch (e) { UI.alert(e.message); }
  }

  // ── 成績總覽 ────────────────────────────────────────────
  async function results(mount) {
    const [{ results: list }, stats] = await Promise.all([API.get('/results'), API.get('/results/stats/overview')]);
    UI.render(mount, 
      el('div', { class: 'toolbar' },
        el('h2', { style: { margin: 0 } }, '成績總覽'),
        stats.pending ? el('span', { class: 'pill warn' }, `${stats.pending} 份待批改`) : null),
      el('div', { class: 'card' },
        el('h3', {}, '各班平均'),
        stats.byClass.length === 0 ? el('p', { class: 'muted' }, '還沒有已批改的成績。')
          : stats.byClass.map((c) => el('div', { class: 'crit-bar' },
              el('span', { class: 'lbl' }, c.class_group || '未分班'),
              el('span', { class: 'meter' }, el('i', { style: { width: `${(Number(c.avg_overall) / 9) * 100}%` } })),
              el('span', { class: 'val' }, band(c.avg_overall))))),
      el('div', { class: 'card' },
        el('h3', {}, '所有考試紀錄'),
        el('div', { style: { overflowX: 'auto' } },
          UI.dataTable(
            el('thead', {}, el('tr', {},
              el('th', {}, '學生'), el('th', {}, '班級'), el('th', {}, '試卷'), el('th', {}, '狀態'),
              el('th', {}, 'L'), el('th', {}, 'R'), el('th', {}, 'W'), el('th', {}, 'S'), el('th', {}, '總分'),
              el('th', {}, '交卷時間'), el('th', {}, ''))),
            el('tbody', {}, list.map((r) => el('tr', {},
              el('td', {}, el('b', {}, r.student_name), el('div', { class: 'small muted' }, r.username)),
              el('td', { class: 'small' }, r.class_group || '—'),
              el('td', { class: 'small' }, r.test_title),
              el('td', {}, statusPill(r.status)),
              el('td', {}, band(r.listening_band)), el('td', {}, band(r.reading_band)),
              el('td', {}, band(r.writing_band)), el('td', {}, band(r.speaking_band)),
              el('td', {}, el('b', { style: { color: 'var(--brand)' } }, band(r.overall_band))),
              el('td', { class: 'small muted' }, fmtDate(r.submitted_at)),
              el('td', {}, el('a', { class: 'btn sm', href: `#/result/${r.id}` }, '檢視'))))))),
        el('div', { style: { marginTop: '.8rem' } },
          el('button', {
            class: 'btn sm',
            onclick: () => UI.download('results.csv',
              '﻿學生,帳號,班級,試卷,聽力,閱讀,寫作,口說,總分,交卷時間\n' +
              list.map((r) => [r.student_name, r.username, r.class_group || '', r.test_title,
                band(r.listening_band), band(r.reading_band), band(r.writing_band), band(r.speaking_band),
                band(r.overall_band), r.submitted_at || ''].join(',')).join('\n'), 'text/csv'),
          }, '⬇ 匯出 CSV'))));
  }

  function statusPill(s) {
    const map = {
      in_progress: ['作答中', ''], submitted: ['已交卷', 'info'],
      grading: ['批改中', 'warn'], graded: ['已完成', 'ok'],
    };
    const [t, k] = map[s] || [s, ''];
    return el('span', { class: `pill ${k}` }, t);
  }

  // ── 系統設定 ────────────────────────────────────────────
  async function settings(mount) {
    const [s, ts, sm] = await Promise.all([
      API.get('/ai/settings'),
      API.get('/manage/turnstile').catch(() => ({ turnstile: null })),
      API.get('/notifications/smtp').catch(() => ({ smtp: null })),
    ]);
    const a = s.ai;
    const f = {};
    const t = {};
    const m = {};

    const sel = (key, opts, val) => (f[key] = el('select', {}, opts.map(([v, t]) => el('option', { value: v, selected: val === v }, t))));
    const txt = (key, val, ph = '') => (f[key] = el('input', { type: 'text', value: val || '', placeholder: ph }));

    UI.render(mount, 
      el('h2', {}, '系統設定'),

      el('div', { class: 'card' },
        el('h3', {}, 'AI 供應商'),
        el('p', { class: 'small muted' }, '出題、貼上解析、寫作批改、口說評分都會用這裡設定的模型。金鑰只存在你自己的伺服器資料庫，不會外流。'),
        el('label', { class: 'field' }, el('span', {}, '主要供應商'),
          sel('provider', [['anthropic', 'Anthropic（Claude）'], ['openai', 'OpenAI'], ['custom', '自訂端點']], a.provider)),

        el('details', { open: a.provider === 'anthropic' }, el('summary', {}, el('b', {}, 'Anthropic / Claude')),
          el('div', { class: 'row', style: { marginTop: '.6rem' } },
            el('label', { class: 'field' }, el('span', {}, 'API Key'), txt('anthropicApiKey', a.anthropicApiKey, 'sk-ant-…')),
            el('label', { class: 'field' }, el('span', {}, 'Base URL'), txt('anthropicBaseUrl', a.anthropicBaseUrl)),
            el('label', { class: 'field' }, el('span', {}, '模型'), txt('anthropicModel', a.anthropicModel)))),

        el('details', { open: a.provider === 'openai' }, el('summary', {}, el('b', {}, 'OpenAI（或任何 OpenAI 相容服務）')),
          el('div', { class: 'row', style: { marginTop: '.6rem' } },
            el('label', { class: 'field' }, el('span', {}, 'API Key'), txt('openaiApiKey', a.openaiApiKey, 'sk-…')),
            el('label', { class: 'field' }, el('span', {}, 'Base URL'), txt('openaiBaseUrl', a.openaiBaseUrl)),
            el('label', { class: 'field' }, el('span', {}, '模型'), txt('openaiModel', a.openaiModel)))),

        el('details', { open: a.provider === 'custom' }, el('summary', {}, el('b', {}, '自訂端點（Azure / DeepSeek / Groq / Ollama / one-api …）')),
          el('div', { class: 'row', style: { marginTop: '.6rem' } },
            el('label', { class: 'field' }, el('span', {}, 'API 格式'),
              sel('customProtocol', [['openai', 'OpenAI 相容'], ['anthropic', 'Anthropic 相容']], a.customProtocol)),
            el('label', { class: 'field' }, el('span', {}, 'API Key'), txt('customApiKey', a.customApiKey)),
            el('label', { class: 'field' }, el('span', {}, 'Base URL'), txt('customBaseUrl', a.customBaseUrl, 'https://your-host/v1')),
            el('label', { class: 'field' }, el('span', {}, '模型'), txt('customModel', a.customModel)))),

        el('h4', { style: { marginTop: '1rem' } }, '語音'),
        el('div', { class: 'row' },
          el('label', { class: 'field' }, el('span', {}, '語音轉文字 供應商'),
            sel('sttProvider', [['openai', 'OpenAI（Whisper）'], ['custom', '自訂端點'], ['none', '不使用（改用瀏覽器辨識）']], a.sttProvider)),
          el('label', { class: 'field' }, el('span', {}, 'STT 模型'), txt('sttModel', a.sttModel)),
          el('label', { class: 'field' }, el('span', {}, '文字轉語音 供應商'),
            sel('ttsProvider', [['openai', 'OpenAI'], ['custom', '自訂端點'], ['none', '不使用（改用瀏覽器語音）']], a.ttsProvider)),
          el('label', { class: 'field' }, el('span', {}, 'TTS 模型'), txt('ttsModel', a.ttsModel)),
          el('label', { class: 'field' }, el('span', {}, '考官聲音'), txt('ttsVoice', a.ttsVoice)),
          el('label', { class: 'field' }, el('span', {}, '即時對話模型 Realtime'),
            txt('realtimeModel', a.realtimeModel, 'gpt-4o-realtime-preview'),
            el('span', { class: 'small muted' }, '口說即時語音對話用；留空或沒有此模型會自動退回問答模式'))),

        el('div', { style: { display: 'flex', gap: '.5rem', marginTop: '.8rem' } },
          el('button', { class: 'btn primary', onclick: saveSettings }, '儲存設定'),
          el('button', {
            class: 'btn',
            onclick: async (e) => {
              e.target.disabled = true; e.target.textContent = '測試中…';
              try { const r = await API.post('/ai/test', { role: 'chat' }); UI.alert(`連線成功：${r.provider} / ${r.model}\n回覆：${r.reply}`); }
              catch (er) { UI.alert(`連線失敗：${er.message}`); }
              e.target.disabled = false; e.target.textContent = '測試文字模型';
            },
          }, '測試文字模型'),
          el('button', {
            class: 'btn',
            onclick: async (e) => {
              e.target.disabled = true;
              try { const r = await API.post('/ai/test', { role: 'tts' }); UI.alert(`語音合成正常（${r.bytes} bytes）`); }
              catch (er) { UI.alert(`語音合成失敗：${er.message}\n\n口說仍可使用瀏覽器內建語音。`); }
              e.target.disabled = false;
            },
          }, '測試語音'))),

      // ── Cloudflare Turnstile ──────────────────────────
      ts.turnstile && el('div', { class: 'card' },
        el('h3', {}, '登入人機驗證（Cloudflare Turnstile）',
          ts.turnstile.active
            ? el('span', { class: 'pill ok', style: { marginLeft: '.6rem' } }, '運作中')
            : el('span', { class: 'pill', style: { marginLeft: '.6rem' } }, '未啟用')),
        el('p', { class: 'small muted' },
          '擋掉自動化的登入嘗試。到 ',
          el('a', { href: 'https://dash.cloudflare.com/?to=/:account/turnstile', target: '_blank', rel: 'noopener' },
            'Cloudflare 主控台 → Turnstile'),
          ' 免費新增一個 Widget，把網域填成你的考試網址，就會拿到 Site Key 與 Secret Key。'),
        el('label', { class: 'field' }, el('span', {},
          (t.enabled = el('input', {
            type: 'checkbox', checked: ts.turnstile.enabled, class: 'check',
          })),
          '啟用登入人機驗證')),
        el('div', { class: 'row' },
          el('label', { class: 'field' }, el('span', {}, 'Site Key（公開，會出現在網頁原始碼）'),
            (t.siteKey = el('input', { type: 'text', value: ts.turnstile.siteKey || '', placeholder: '0x4AAAAAAA…' }))),
          el('label', { class: 'field' }, el('span', {}, 'Secret Key（只存在伺服器）'),
            (t.secretKey = el('input', {
              type: 'text', value: ts.turnstile.secretKey || '',
              placeholder: ts.turnstile.hasSecret ? '（已設定，留著不動就不會變更）' : '0x4AAAAAAA…',
            })))),
        el('label', { class: 'field' }, el('span', {},
          (t.failOpen = el('input', {
            type: 'checkbox', checked: ts.turnstile.failOpen, class: 'check',
          })),
          '連不到 Cloudflare 時仍允許登入（建議勾選）'),
          el('span', { class: 'small muted' },
            '不勾的話，Cloudflare 或校內網路一出問題，全校就都登不進來。登入本來就還有速率限制擋暴力破解。')),
        el('div', { class: 'toolbar' },
          el('button', {
            class: 'btn primary',
            onclick: async () => {
              try {
                const r = await API.put('/manage/turnstile', {
                  turnstile: {
                    enabled: t.enabled.checked,
                    failOpen: t.failOpen.checked,
                    siteKey: t.siteKey.value.trim(),
                    secretKey: t.secretKey.value.trim(),
                  },
                });
                toast(r.turnstile.active ? '已啟用人機驗證' : '設定已儲存（目前未啟用）', 'ok');
                settings(mount);
              } catch (e) { UI.alert(e.message); }
            },
          }, '儲存驗證設定'),
          el('button', {
            class: 'btn',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                const r = await API.post('/manage/turnstile/test', {});
                UI.alert(r.ok ? `✓ ${r.message}` : `✗ ${r.error}`);
              } catch (er) { UI.alert(`✗ ${er.message}`); }
              e.target.disabled = false;
            },
          }, '測試 Secret Key'),
          el('button', {
            class: 'btn sm',
            onclick: () => {
              t.siteKey.value = '1x00000000000000000000AA';
              t.secretKey.value = '1x0000000000000000000000000000000AA';
              toast('已填入 Cloudflare 官方測試金鑰（一律通過），記得正式上線要換掉', 'ok');
            },
          }, '填入測試金鑰')),
        el('p', { class: 'small muted' },
          el('b', { style: { color: 'var(--warn)' } }, '啟用前務必確認兩件事：'), el('br'),
          '① Cloudflare 的 Widget 設定裡要把你的考試網域加進去，否則驗證一律失敗（用 IP 直連時填 ',
          el('code', {}, 'localhost'), ' 或關掉網域檢查）。', el('br'),
          '② 學生的電腦要連得到 ', el('code', {}, 'challenges.cloudflare.com'),
          '。校內網路若擋掉這個網域，所有人都會登不進來 —— ',
          '這種情況「連不到 Cloudflare 時仍允許登入」也救不了，因為瀏覽器根本產不出驗證碼。', el('br'),
          '建議先開起來自己用學生電腦登入試一次，確認沒問題再正式宣布。'),
        el('div', {
          class: 'small',
          style: {
            marginTop: '.6rem', padding: '.6rem .7rem', lineHeight: '1.8',
            background: '#f6f8fa', border: '1px solid var(--line-2)', borderRadius: '4px',
          },
        },
          el('b', {}, '被鎖在外面怎麼辦'), el('br'),
          '如果驗證框壞掉、連管理員都登不進來，到伺服器上執行：', el('br'),
          el('code', { style: { display: 'block', margin: '.3rem 0', userSelect: 'all' } },
            'docker compose exec app node server/scripts/turnstile.js --off'),
          el('span', { class: 'muted' },
            '最多 15 秒後生效，不用重啟。也可以在 .env 加 ',
            el('code', {}, 'TURNSTILE_DISABLED=1'), ' 再重啟，效果一樣。'),
          el('div', { class: 'muted', style: { marginTop: '.3rem' } },
            '目前這個後台的網址是 ', el('code', {}, location.host),
            ' —— Cloudflare Widget 的網域清單裡要有這一個（不含連接埠）。'))),

      // ── Email 通知（選用）─────────────────────────────
      sm.smtp && smtpCard(sm.smtp),

      el('div', { class: 'card' },
        el('h3', {}, '批改規則'),
        el('label', { class: 'field' }, el('span', {},
          (f.allowSpellingVariants = el('input', { type: 'checkbox', checked: s.marking.allowSpellingVariants, class: 'check' })),
          '接受英式／美式拼法差異（colour = color、centre = center）')),
        el('label', { class: 'field' }, el('span', {},
          (f.hyphenEqualsSpace = el('input', { type: 'checkbox', checked: s.marking.hyphenEqualsSpace, class: 'check' })),
          '連字號與空白視為相同（well-known = well known）')),
        el('label', { class: 'field' }, el('span', {},
          (f.expandContractions = el('input', { type: 'checkbox', checked: s.marking.expandContractions, class: 'check' })),
          '縮寫與完整寫法視為相同（don\'t = do not）')),
        el('p', { class: 'small muted' }, '大小寫、句尾標點、前後空白一律忽略；括號內文字視為可有可無；超過字數限制一律不給分（官方規則）。')),

      el('div', { class: 'card' },
        el('h3', {}, '原始分 → Band 對照表'),
        el('p', { class: 'small muted' }, '格式為「最低原始分:分數」，一行一個，由高到低。官方每場考試會微調，可依你的需求修改。'),
        el('div', { class: 'row' },
          ['listening', 'reading_academic', 'reading_general'].map((k) =>
            el('label', { class: 'field' }, el('span', {}, k),
              (f[`tbl_${k}`] = el('textarea', {
                rows: 10, style: { fontFamily: 'monospace', fontSize: '.8rem' },
              }, (s.marking.bandTables[k] || []).map(([n, b]) => `${n}:${b}`).join('\n')))))),
        el('button', { class: 'btn primary', onclick: saveSettings }, '儲存設定')));

    async function saveSettings() {
      const aiPatch = {};
      for (const k of ['provider', 'anthropicApiKey', 'anthropicBaseUrl', 'anthropicModel',
        'openaiApiKey', 'openaiBaseUrl', 'openaiModel', 'customProtocol', 'customApiKey',
        'customBaseUrl', 'customModel', 'sttProvider', 'sttModel', 'ttsProvider', 'ttsModel',
        'ttsVoice', 'realtimeModel']) {
        if (f[k]) aiPatch[k] = f[k].value;
      }
      const bandTables = {};
      for (const k of ['listening', 'reading_academic', 'reading_general']) {
        const lines = String(f[`tbl_${k}`].value).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        bandTables[k] = lines.map((l) => l.split(':').map(Number)).filter((p) => p.length === 2 && !p.some(Number.isNaN));
      }
      try {
        await API.put('/ai/settings', {
          ai: aiPatch,
          marking: {
            allowSpellingVariants: f.allowSpellingVariants.checked,
            hyphenEqualsSpace: f.hyphenEqualsSpace.checked,
            expandContractions: f.expandContractions.checked,
            bandTables,
          },
        });
        toast('設定已儲存', 'ok');
      } catch (e) { UI.alert(e.message); }
    }

    // ── Email 通知（選用）──────────────────────────────────
    // 站內通知不需要任何設定就會送到；這一區只是「順便寄一封 Email」。
    // 沒填、填錯、或郵件主機掛掉，都不會影響站內通知或指派本身。
    function smtpCard(c) {
      const canEdit = API.user?.role === 'admin';
      const chk = (key, on) => (m[key] = el('input', { type: 'checkbox', checked: !!on, class: 'check', disabled: !canEdit }));
      const inp = (key, val, ph = '', type = 'text') =>
        (m[key] = el('input', { type, value: val == null ? '' : String(val), placeholder: ph, disabled: !canEdit }));

      // 注意：這裡不能在 render 當下讀 m.host.value —— 輸入框還沒建出來。
      // 所以 host 是 null 時就代表「只改連接埠，主機留著不動」。
      const preset = (label, cfg, hint) => el('button', {
        class: 'btn sm',
        title: hint,
        onclick: () => {
          if (cfg.host != null) m.host.value = cfg.host;
          m.port.value = cfg.port;
          m.secure.checked = !!cfg.secure;
          toast(hint || `已填入 ${label} 的主機設定`, 'ok');
        },
      }, label);

      return el('div', { class: 'card' },
        el('h3', {}, 'Email 通知（選用）',
          c.active
            ? el('span', { class: 'pill ok', style: { marginLeft: '.6rem' } }, '運作中')
            : el('span', { class: 'pill', style: { marginLeft: '.6rem' } }, '未啟用')),
        el('p', { class: 'small muted' },
          '站內通知（右上角鈴鐺）不需要任何設定就會送到。這一區設定好之後，指派考試與批改完成時',
          el('b', {}, '再多寄一封 Email'), '給有填信箱的學生。',
          '沒設定、設定錯誤、或郵件主機當掉，都只是不寄信而已，站內通知照常。'),

        el('label', { class: 'field' }, el('span', {},
          chk('enabled', c.enabled), '啟用 Email 通知')),

        el('div', { class: 'toolbar', style: { marginBottom: '.2rem' } },
          el('span', { class: 'small muted' }, '常用設定：'),
          preset('Gmail', { host: 'smtp.gmail.com', port: 587, secure: false },
            'Gmail 要用「應用程式密碼」，不是你平常登入的密碼'),
          preset('Microsoft 365', { host: 'smtp.office365.com', port: 587, secure: false },
            '帳號填完整信箱，密碼可能要先在 Microsoft 帳戶開應用程式密碼'),
          preset('改用 SSL 465', { host: null, port: 465, secure: true },
            '主機不動，改成一開始就加密的 465 連接埠')),

        el('div', { class: 'row' },
          el('label', { class: 'field' }, el('span', {}, 'SMTP 主機'),
            inp('host', c.host, 'smtp.gmail.com')),
          el('label', { class: 'field' }, el('span', {}, '連接埠'),
            inp('port', c.port || 587, '587', 'number')),
          el('label', { class: 'field' }, el('span', {}, '帳號（留空 = 不需登入）'),
            inp('user', c.user, 'you@example.com')),
          el('label', { class: 'field' }, el('span', {}, '密碼 / 應用程式密碼'),
            inp('pass', c.pass, c.hasPass ? '（已設定，留著不動就不會變更）' : '', 'password'))),

        el('label', { class: 'field' }, el('span', {},
          chk('secure', c.secure), '連線一開始就加密（連接埠 465 用這個）'),
          el('span', { class: 'small muted' },
            '587 請不要勾 —— 那是先連明文再升級成 TLS（STARTTLS），系統會自動處理。')),

        el('div', { class: 'row' },
          el('label', { class: 'field' }, el('span', {}, '寄件人信箱'),
            inp('from', c.from, 'noreply@your-school.edu')),
          el('label', { class: 'field' }, el('span', {}, '寄件人顯示名稱'),
            inp('fromName', c.fromName || 'IELTS 模擬考', 'IELTS 模擬考'))),

        canEdit ? el('div', { class: 'toolbar' },
          el('button', {
            class: 'btn primary',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                const r = await API.put('/notifications/smtp', {
                  smtp: {
                    enabled: m.enabled.checked,
                    secure: m.secure.checked,
                    host: m.host.value.trim(),
                    port: Number(m.port.value) || 587,
                    user: m.user.value.trim(),
                    pass: m.pass.value,
                    from: m.from.value.trim(),
                    fromName: m.fromName.value.trim(),
                  },
                });
                toast(r.smtp.active ? 'Email 通知已啟用' : '設定已儲存（目前未啟用）', 'ok');
                settings(mount);
              } catch (er) { UI.alert(er.message); e.target.disabled = false; }
            },
          }, '儲存 Email 設定'),
          el('button', {
            class: 'btn',
            onclick: async (e) => {
              const box = el('input', { type: 'email', value: API.user?.email || '', placeholder: 'you@example.com' });
              const ok = await UI.modal({
                title: '寄一封測試信',
                body: el('div', {},
                  el('p', { class: 'small muted' }, '會用上面「已儲存」的設定寄信 —— 如果剛改過欄位，請先按儲存。'),
                  el('label', { class: 'field' }, el('span', {}, '收件信箱'), box)),
                actions: [
                  { label: '取消', value: false },
                  {
                    label: '寄出',
                    class: 'primary',
                    value: true,
                    // 空白就不要默默關掉視窗 —— 使用者會以為信寄出去了
                    onClick: () => { if (!box.value.trim()) { toast('請填收件信箱', 'warn'); return false; } return true; },
                  },
                ],
              });
              if (!ok) return;
              e.target.disabled = true; e.target.textContent = '寄送中…';
              try {
                const r = await API.post('/notifications/smtp/test', { to: box.value.trim() });
                UI.alert(`✓ ${r.message}\n\n收不到的話記得看一下垃圾郵件匣。`);
              } catch (er) { UI.alert(`✗ ${er.message}`); }
              e.target.disabled = false; e.target.textContent = '寄測試信';
            },
          }, '寄測試信'))
          : el('p', { class: 'small muted' }, '只有管理員能修改寄信設定。'),

        el('p', { class: 'small muted' },
          el('b', {}, '注意：'), '密碼會存在你自己的伺服器資料庫，載入這一頁時只會回傳遮罩後的 ',
          el('code', {}, '••••••'), '，不會把真的密碼送到瀏覽器。要換密碼就直接覆蓋掉那個欄位；',
          '不想動就整欄留著不要碰。'),
        el('p', { class: 'small muted' },
          '寄不出去最常見的三個原因：① Gmail／Microsoft 要用應用程式密碼，不是登入密碼；',
          '② 學校防火牆擋掉對外的 25／465／587 連接埠；③ 寄件人信箱和登入帳號不同網域，被對方伺服器當成偽造退回。'));
    }
  }

  // ══ 檔案管理 ══════════════════════════════════════════════
  const fmtBytes = (b) => {
    b = Number(b || 0);
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
    return `${(b / 1073741824).toFixed(2)} GB`;
  };

  async function files(mount) {
    const filter = { kind: '', folder: '', q: '', unusedOnly: false };
    const selected = new Set();

    const box = el('div');
    const summary = el('div', { class: 'small muted' });

    async function load() {
      const qs = new URLSearchParams();
      if (filter.kind) qs.set('kind', filter.kind);
      if (filter.folder) qs.set('folder', filter.folder);
      if (filter.q) qs.set('q', filter.q);
      if (filter.unusedOnly) qs.set('unusedOnly', '1');
      const d = await API.get(`/manage/media?${qs}`);

      summary.textContent = `${d.media.length} 個檔案 · 共 ${fmtBytes(d.total.bytes)}`;
      UI.render(box,
        d.media.length === 0
          ? el('div', { class: 'empty' }, '沒有符合條件的檔案。')
          : UI.dataTable(
              el('thead', {}, el('tr', {},
                el('th', {}, el('input', {
                  type: 'checkbox',
                  onchange: (e) => {
                    selected.clear();
                    if (e.target.checked) d.media.forEach((m) => selected.add(m.id));
                    load();
                  },
                })),
                el('th', {}, '預覽'), el('th', {}, '檔名'), el('th', {}, '資料夾'),
                el('th', {}, '大小'), el('th', {}, '使用中'), el('th', {}, '網址'), el('th', {}, ''))),
              el('tbody', {}, d.media.map((m) => el('tr', {},
                el('td', {}, el('input', {
                  type: 'checkbox', checked: selected.has(m.id),
                  onchange: (e) => { e.target.checked ? selected.add(m.id) : selected.delete(m.id); },
                })),
                el('td', {}, m.kind === 'audio'
                  ? el('audio', { controls: true, src: m.url, style: { height: '30px', maxWidth: '170px' } })
                  : el('img', { src: m.url, style: { maxHeight: '42px', borderRadius: '3px' } })),
                el('td', {}, el('div', {}, m.name),
                  el('div', { class: 'small muted' }, UI.fmtDate(m.createdAt), m.uploader ? ` · ${m.uploader}` : '')),
                el('td', {}, el('input', {
                  type: 'text', value: m.folder || '', placeholder: '（無）',
                  style: { width: '110px', padding: '.2rem .35rem', fontSize: '.85rem' },
                  onchange: async (e) => {
                    await API.put(`/manage/media/${m.id}`, { label: m.label, folder: e.target.value, tags: m.tags });
                    toast('已更新', 'ok'); load();
                  },
                })),
                el('td', { class: 'small' }, fmtBytes(m.size)),
                el('td', {}, m.usedBy.length
                  ? el('span', { class: 'pill ok', title: m.usedBy.map((t) => t.title).join('\n') }, `${m.usedBy.length} 份試卷`)
                  : el('span', { class: 'pill warn' }, '沒用到')),
                el('td', {}, el('code', {
                  class: 'small', style: { cursor: 'pointer' },
                  onclick: () => { navigator.clipboard?.writeText(m.url); toast('已複製網址', 'ok'); },
                }, m.url)),
                el('td', {}, el('button', {
                  class: 'btn sm danger',
                  onclick: async () => {
                    if (!(await UI.confirm(`刪除「${m.name}」？`))) return;
                    try {
                      await API.post('/manage/media/bulk', { action: 'delete', ids: [m.id] });
                      toast('已刪除', 'ok'); load();
                    } catch (e) {
                      if (!(await UI.confirm(`${e.message}。仍要強制刪除嗎？`))) return;
                      await API.post('/manage/media/bulk', { action: 'delete', ids: [m.id], force: true });
                      load();
                    }
                  },
                }, '刪除')))))));

      UI.render(folderSel,
        el('option', { value: '' }, '全部資料夾'),
        d.folders.map((f) => el('option', { value: f.name, selected: filter.folder === f.name },
          `${f.name}（${f.n}）`)));
    }

    const folderSel = el('select', { onchange: (e) => { filter.folder = e.target.value; load(); } });
    const uploadFolder = el('input', { type: 'text', placeholder: '資料夾（選填）', style: { maxWidth: '170px' } });

    UI.render(mount,
      el('div', { class: 'toolbar' },
        el('h2', { style: { margin: 0 } }, '檔案管理'),
        el('span', { style: { flex: 1 } }),
        summary),

      el('div', { class: 'card' },
        el('div', { class: 'toolbar' },
          uploadFolder,
          el('input', {
            type: 'file', multiple: true, accept: 'audio/*,image/*',
            onchange: async (e) => {
              const fd = new FormData();
              [...e.target.files].forEach((f) => fd.append('files', f));
              if (uploadFolder.value) fd.append('folder', uploadFolder.value);
              try { await API.post('/media', fd); toast('上傳完成', 'ok'); e.target.value = ''; load(); }
              catch (er) { UI.alert(er.message); }
            },
          })),
        el('div', { class: 'toolbar' },
          el('input', {
            type: 'text', placeholder: '搜尋檔名／標籤', style: { maxWidth: '220px' },
            oninput: UI.debounce((e) => { filter.q = e.target.value; load(); }, 350),
          }),
          el('select', { onchange: (e) => { filter.kind = e.target.value; load(); } },
            el('option', { value: '' }, '全部類型'),
            el('option', { value: 'audio' }, '音檔'),
            el('option', { value: 'image' }, '圖片')),
          folderSel,
          el('label', { class: 'small', style: { display: 'flex', alignItems: 'center', gap: '.3rem' } },
            el('input', {
              type: 'checkbox', style: { width: 'auto' },
              onchange: (e) => { filter.unusedOnly = e.target.checked; load(); },
            }), '只看沒被試卷用到的'),
          el('span', { style: { flex: 1 } }),
          el('button', {
            class: 'btn sm',
            onclick: async () => {
              if (!selected.size) return UI.alert('請先勾選檔案');
              const f = prompt('把選取的檔案移到哪個資料夾？（留空 = 移出資料夾）');
              if (f === null) return;
              await API.post('/manage/media/bulk', { action: 'move', ids: [...selected], folder: f });
              toast('已移動', 'ok'); selected.clear(); load();
            },
          }, '移到資料夾'),
          el('button', {
            class: 'btn sm danger',
            onclick: async () => {
              if (!selected.size) return UI.alert('請先勾選檔案');
              if (!(await UI.confirm(`確定刪除 ${selected.size} 個檔案？`))) return;
              try {
                const r = await API.post('/manage/media/bulk', { action: 'delete', ids: [...selected] });
                toast(`已刪除 ${r.deleted} 個，釋放 ${fmtBytes(r.freedBytes)}`, 'ok');
              } catch (e) {
                if (!(await UI.confirm(`${e.message}。仍要強制刪除嗎？`))) return;
                await API.post('/manage/media/bulk', { action: 'delete', ids: [...selected], force: true });
              }
              selected.clear(); load();
            },
          }, '刪除選取')),
        box));

    load();
  }

  // ══ 考試資料與成績管理 ════════════════════════════════════
  async function data(mount) {
    const holder = el('div');
    const tabs = [['overview', '總覽與清理'], ['results', '成績管理'], ['papers', '試卷管理'], ['log', '維護紀錄']];
    const bar = el('div', { class: 'tabs' }, tabs.map(([k, label], i) =>
      el('button', {
        class: i === 0 ? 'active' : '',
        onclick: (e) => {
          [...bar.children].forEach((c) => c.classList.remove('active'));
          e.target.classList.add('active');
          panes[k](holder);
        },
      }, label)));

    UI.render(mount, el('h2', {}, '考試資料管理'), bar, holder);
    panes.overview(holder);
  }

  const panes = {
    async overview(host) {
      UI.render(host, UI.loading());
      const d = await API.get('/manage/overview');
      const p = d.policy;
      const f = {};
      const num = (key, label, hint) => el('label', { class: 'field' },
        el('span', {}, label), (f[key] = el('input', { type: 'number', min: 0, value: p[key] })),
        el('span', { class: 'small muted' }, hint));

      const cleanupOut = el('div');

      const runCleanup = async (dryRun) => {
        const policy = {};
        for (const k of Object.keys(f)) policy[k] = Number(f[k].value) || 0;
        try {
          const { report } = await API.post('/manage/cleanup', { dryRun, policy });
          UI.render(cleanupOut, el('div', { class: 'card', style: { background: dryRun ? '#fbfbfb' : '#f3fbf5' } },
            el('h3', {}, dryRun ? '試算結果（沒有真的刪除）' : '清理完成'),
            report.items.length === 0
              ? el('p', { class: 'muted' }, '目前沒有符合條件的資料。')
              : UI.dataTable(
                  el('thead', {}, el('tr', {}, el('th', {}, '項目'), el('th', {}, '筆數'), el('th', {}, '空間'), el('th', {}, '條件'))),
                  el('tbody', {}, report.items.map((i) => el('tr', {},
                    el('td', {}, i.action), el('td', {}, String(i.count)),
                    el('td', {}, fmtBytes(i.bytes)), el('td', { class: 'small muted' }, i.detail))))),
            el('p', {}, el('b', {}, `合計 ${report.affected} 筆，${fmtBytes(report.freedBytes)}`))));
        } catch (e) { UI.alert(e.message); }
      };

      UI.render(host,
        el('div', { class: 'card' },
          el('h3', {}, '空間使用'),
          el('div', { class: 'row' },
            el('div', {}, el('div', { class: 'small muted' }, '資料庫'), el('div', { style: { fontSize: '1.5rem', fontWeight: '700' } }, fmtBytes(d.dbBytes))),
            el('div', {}, el('div', { class: 'small muted' }, '上傳檔案'), el('div', { style: { fontSize: '1.5rem', fontWeight: '700' } }, fmtBytes(d.storage.totalBytes))),
            el('div', {}, el('div', { class: 'small muted' }, '聽力音檔'), el('div', { style: { fontSize: '1.2rem' } }, `${fmtBytes(d.storage.audio.bytes)} / ${d.storage.audio.files} 個`)),
            el('div', {}, el('div', { class: 'small muted' }, '圖片'), el('div', { style: { fontSize: '1.2rem' } }, `${fmtBytes(d.storage.image.bytes)} / ${d.storage.image.files} 個`)),
            el('div', {}, el('div', { class: 'small muted' }, '口說錄音'), el('div', { style: { fontSize: '1.2rem' } }, `${fmtBytes(d.storage.speaking.bytes)} / ${d.storage.speaking.files} 個`))),
          d.unusedMedia.count
            ? el('p', { class: 'small', style: { marginTop: '.8rem' } },
                el('span', { class: 'pill warn' }, `${d.unusedMedia.count} 個媒體檔沒有被任何試卷使用`),
                ` 佔 ${fmtBytes(d.unusedMedia.bytes)}　`,
                el('a', { href: '#/admin/files' }, '去檔案管理處理 →'))
            : null),

        el('div', { class: 'card' },
          el('h3', {}, '資料筆數'),
          el('div', { class: 'row' }, Object.entries({
            使用者: d.counts.users, 試卷: d.counts.tests, 指派: d.counts.assignments,
            考試場次: d.counts.attempts, 作答: d.counts.answers, 作文: d.counts.writing_responses,
            口說: d.counts.speaking_responses, 媒體檔: d.counts.media, AI紀錄: d.counts.ai_logs,
          }).map(([k, v]) => el('div', { style: { minWidth: '90px', flex: '0 0 auto' } },
            el('div', { class: 'small muted' }, k),
            el('div', { style: { fontSize: '1.3rem', fontWeight: '700' } }, String(v))))),
          el('p', { class: 'small muted', style: { marginTop: '.6rem' } },
            '最舊的成績：', UI.fmtDate(d.oldestResult)),
          d.byMonth.length ? el('div', { style: { marginTop: '.8rem' } },
            el('div', { class: 'small muted' }, '各月考試量'),
            d.byMonth.slice(0, 12).map((m) => el('div', { class: 'crit-bar' },
              el('span', { class: 'lbl small' }, m.ym || '—'),
              el('span', { class: 'meter' }, el('i', {
                style: { width: `${(Number(m.n) / Math.max(...d.byMonth.map((x) => Number(x.n)))) * 100}%` },
              })),
              el('span', { class: 'val small' }, String(m.n))))) : null),

        el('div', { class: 'card' },
          el('h3', {}, '自動清理設定'),
          el('p', { class: 'small muted' }, '填 0 代表「永久保留、不自動刪除」。刪除無法復原，建議先按「試算」看看會刪掉什麼。'),
          el('label', { class: 'field' }, el('span', {},
            (f.enabled = el('input', { type: 'checkbox', checked: p.enabled, class: 'check' })),
            '啟用每天自動清理')),
          el('div', { class: 'row' },
            num('keepResultsMonths', '成績保留（月）', '超過就連同作答、錄音一起刪除'),
            num('keepSpeakingAudioMonths', '口說錄音保留（月）', '只刪音檔，逐字稿與分數保留'),
            num('keepAbandonedDays', '未完成考試保留（天）', '開始了卻沒交卷的場次')),
          el('div', { class: 'row' },
            num('keepAiLogsDays', 'AI 呼叫紀錄保留（天）', ''),
            num('keepReadNotificationsDays', '已讀通知保留（天）', '未讀的通知一律保留'),
            num('deleteUnusedMediaDays', '未使用媒體檔保留（天）', '沒有任何試卷引用的檔案')),
          el('div', { class: 'row' },
            num('keepDeviceChecksDays', '考前環境檢查紀錄保留（天）', ''),
            num('runAtHour', '每天執行時間（點）', '0–23，伺服器時間')),
          el('div', { class: 'toolbar', style: { marginTop: '.8rem' } },
            el('button', {
              class: 'btn primary',
              onclick: async () => {
                const policy = { enabled: f.enabled.checked };
                for (const k of Object.keys(f)) if (k !== 'enabled') policy[k] = Number(f[k].value) || 0;
                try { await API.put('/manage/policy', { policy }); toast('設定已儲存', 'ok'); }
                catch (e) { UI.alert(e.message); }
              },
            }, '儲存設定'),
            el('button', { class: 'btn', onclick: () => runCleanup(true) }, '🔍 試算（不刪除）'),
            el('button', {
              class: 'btn danger',
              onclick: async () => {
                if (!(await UI.confirm('確定要依上面的設定實際刪除資料嗎？此操作無法復原。', '執行清理'))) return;
                await runCleanup(false);
              },
            }, '⚠ 立即執行清理')),
          cleanupOut));
    },

    async results(host) {
      const filter = { from: '', to: '', classGroup: '', testId: '', status: '', beforeMonths: '', archived: '' };
      const selected = new Set();
      const box = el('div');
      const info = el('div', { class: 'small muted' });

      const [{ tests: testList }, { classes }] = await Promise.all([
        API.get('/tests'), API.get('/users/classes'),
      ]);

      const qs = () => {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(filter)) if (v) p.set(k, v);
        return p;
      };

      async function load() {
        UI.render(box, el('div', { class: 'empty' }, '查詢中…'));
        const d = await API.get(`/manage/results?${qs()}`);
        info.textContent = `符合條件 ${d.summary.count} 筆，平均總分 ${d.summary.avgBand ? d.summary.avgBand.toFixed(2) : '—'}`
          + (d.truncated ? '（只顯示前 500 筆）' : '');
        UI.render(box, d.results.length === 0
          ? el('div', { class: 'empty' }, '沒有符合條件的成績。')
          : UI.dataTable(
              el('thead', {}, el('tr', {},
                el('th', {}, el('input', {
                  type: 'checkbox',
                  onchange: (e) => { selected.clear(); if (e.target.checked) d.results.forEach((r) => selected.add(r.id)); load(); },
                })),
                el('th', {}, '學生'), el('th', {}, '班級'), el('th', {}, '試卷'), el('th', {}, '狀態'),
                el('th', {}, 'L'), el('th', {}, 'R'), el('th', {}, 'W'), el('th', {}, 'S'), el('th', {}, '總分'),
                el('th', {}, '日期'), el('th', {}, ''))),
              el('tbody', {}, d.results.map((r) => el('tr', { style: r.archived ? { opacity: '.55' } : {} },
                el('td', {}, el('input', {
                  type: 'checkbox', checked: selected.has(r.id),
                  onchange: (e) => { e.target.checked ? selected.add(r.id) : selected.delete(r.id); },
                })),
                el('td', {}, el('b', {}, r.student_name), el('div', { class: 'small muted' }, r.username)),
                el('td', { class: 'small' }, r.class_group || '—'),
                el('td', { class: 'small' }, r.test_title),
                el('td', {}, statusPill(r.status), r.archived ? el('span', { class: 'pill' }, '已封存') : null),
                el('td', {}, band(r.listening_band)), el('td', {}, band(r.reading_band)),
                el('td', {}, band(r.writing_band)), el('td', {}, band(r.speaking_band)),
                el('td', {}, el('b', { style: { color: 'var(--brand)' } }, band(r.overall_band))),
                el('td', { class: 'small muted' }, UI.fmtDate(r.submitted_at || r.started_at)),
                el('td', {}, el('a', { class: 'btn sm', href: `#/result/${r.id}` }, '檢視')))))));
      }

      const bulk = async (action, needConfirm) => {
        const useFilter = !selected.size;
        if (useFilter && !Object.values(filter).some(Boolean))
          return UI.alert('請先勾選資料，或至少設定一個篩選條件（避免誤刪全部）。');
        const payload = useFilter ? { action, filter } : { action, ids: [...selected] };

        if (needConfirm) {
          const pre = await API.post('/manage/results/bulk', { ...payload, action: 'preview' });
          const ok = await UI.confirm(`這會影響 ${pre.affected} 筆成績，且無法復原。確定執行嗎？`, '確定刪除');
          if (!ok) return;
        }
        try {
          const r = await API.post('/manage/results/bulk', payload);
          toast(`完成：${r.deleted ?? r.affected} 筆`, 'ok');
        } catch (e) {
          if (e.details?.needsForce) {
            const ok = await UI.confirm(`${e.message}\n再次確認要刪除嗎？`, '仍要刪除');
            if (!ok) return;
            const r = await API.post('/manage/results/bulk', { ...payload, force: true });
            toast(`已刪除 ${r.deleted} 筆，釋放 ${fmtBytes(r.freedBytes)}`, 'ok');
          } else return UI.alert(e.message);
        }
        selected.clear(); load();
      };

      UI.render(host,
        el('div', { class: 'card' },
          el('div', { class: 'row' },
            el('label', { class: 'field' }, el('span', {}, '起始日期'),
              el('input', { type: 'date', onchange: (e) => { filter.from = e.target.value; load(); } })),
            el('label', { class: 'field' }, el('span', {}, '結束日期'),
              el('input', { type: 'date', onchange: (e) => { filter.to = e.target.value; load(); } })),
            el('label', { class: 'field' }, el('span', {}, '班級'),
              el('select', { onchange: (e) => { filter.classGroup = e.target.value; load(); } },
                el('option', { value: '' }, '全部'),
                classes.map((c) => el('option', { value: c.name }, c.name)))),
            el('label', { class: 'field' }, el('span', {}, '試卷'),
              el('select', { onchange: (e) => { filter.testId = e.target.value; load(); } },
                el('option', { value: '' }, '全部'),
                testList.map((t) => el('option', { value: t.id }, t.title)))),
            el('label', { class: 'field' }, el('span', {}, '狀態'),
              el('select', { onchange: (e) => { filter.status = e.target.value; load(); } },
                el('option', { value: '' }, '全部'),
                el('option', { value: 'graded' }, '已完成'),
                el('option', { value: 'grading' }, '批改中'),
                el('option', { value: 'submitted' }, '已交卷'),
                el('option', { value: 'in_progress' }, '作答中'))),
            el('label', { class: 'field' }, el('span', {}, '只看幾個月前'),
              el('select', { onchange: (e) => { filter.beforeMonths = e.target.value; load(); } },
                el('option', { value: '' }, '不限'),
                [3, 6, 12, 24, 36].map((m) => el('option', { value: m }, `${m} 個月以前`))))),
          el('div', { class: 'toolbar' },
            info,
            el('span', { style: { flex: 1 } }),
            el('a', { class: 'btn sm', href: `#`, onclick: (e) => { e.preventDefault(); window.open(`/api/manage/results/export.csv?${qs()}&token=${encodeURIComponent(API.token)}`); } }, '⬇ 匯出 CSV'),
            el('button', { class: 'btn sm', onclick: () => bulk('archive', false) }, '封存'),
            el('button', { class: 'btn sm', onclick: () => bulk('unarchive', false) }, '取消封存'),
            el('button', { class: 'btn sm danger', onclick: () => bulk('delete', true) }, '刪除')),
          el('p', { class: 'small muted' },
            '沒有勾選任何一列時，批次動作會套用到「目前篩選條件」的全部資料 —— 例如選「24 個月以前」再按刪除，就會清掉兩年前的成績。'),
          box));

      load();
    },

    async papers(host) {
      const selected = new Set();
      const box = el('div');

      async function load() {
        const { tests: list } = await API.get('/manage/tests');
        UI.render(box, UI.dataTable(
          el('thead', {}, el('tr', {},
            el('th', {}, el('input', {
              type: 'checkbox',
              onchange: (e) => { selected.clear(); if (e.target.checked) list.forEach((t) => selected.add(t.id)); load(); },
            })),
            el('th', {}, '標題'), el('th', {}, '狀態'), el('th', {}, '考試紀錄'),
            el('th', {}, '指派'), el('th', {}, '大小'), el('th', {}, '更新'), el('th', {}, ''))),
          el('tbody', {}, list.map((t) => el('tr', { style: t.archived ? { opacity: '.55' } : {} },
            el('td', {}, el('input', {
              type: 'checkbox', checked: selected.has(t.id),
              onchange: (e) => { e.target.checked ? selected.add(t.id) : selected.delete(t.id); },
            })),
            el('td', {}, el('b', {}, t.title),
              el('div', { class: 'small muted' }, t.test_type === 'general' ? 'General Training' : 'Academic', ' · ', t.author || '')),
            el('td', {},
              t.archived ? el('span', { class: 'pill' }, '已封存')
                : t.published ? el('span', { class: 'pill ok' }, '已發布') : el('span', { class: 'pill' }, '草稿')),
            el('td', {}, String(t.attempts)),
            el('td', {}, String(t.assignments)),
            el('td', { class: 'small' }, fmtBytes(t.content_bytes)),
            el('td', { class: 'small muted' }, UI.fmtDate(t.updated_at)),
            el('td', { style: { whiteSpace: 'nowrap' } },
              el('button', {
                class: 'btn sm',
                onclick: () => window.open(`/api/manage/backup/test/${t.id}.json?token=${encodeURIComponent(API.token)}`),
              }, '完整備份'),
              ' ',
              el('button', {
                class: 'btn sm',
                onclick: () => window.open(`/api/import/export/${t.id}?token=${encodeURIComponent(API.token)}`),
              }, '匯出題目')))))));
      }

      const bulk = async (action) => {
        if (!selected.size) return UI.alert('請先勾選試卷');
        try {
          const r = await API.post('/manage/tests/bulk', { action, ids: [...selected] });
          toast(`完成：${r.affected ?? r.deleted} 份`, 'ok');
        } catch (e) {
          if (e.details?.needsForce) {
            const ok = await UI.confirm(`${e.message}`, '仍要刪除');
            if (!ok) return;
            await API.post('/manage/tests/bulk', { action, ids: [...selected], force: true });
            toast('已刪除', 'ok');
          } else return UI.alert(e.message);
        }
        selected.clear(); load();
      };

      UI.render(host,
        el('div', { class: 'card' },
          el('div', { class: 'toolbar' },
            el('button', { class: 'btn sm', onclick: () => bulk('publish') }, '發布'),
            el('button', { class: 'btn sm', onclick: () => bulk('unpublish') }, '取消發布'),
            el('button', { class: 'btn sm', onclick: () => bulk('archive') }, '封存'),
            el('button', { class: 'btn sm', onclick: () => bulk('unarchive') }, '取消封存'),
            el('span', { style: { flex: 1 } }),
            el('button', { class: 'btn sm danger', onclick: () => bulk('delete') }, '刪除')),
          el('p', { class: 'small muted' }, '封存的試卷不會出現在學生端，但成績與題目都保留。刪除會連同底下所有考試紀錄一起移除。'),
          box));
      load();
    },

    async log(host) {
      const { log } = await API.get('/manage/log');
      UI.render(host, el('div', { class: 'card' },
        el('h3', {}, '維護紀錄'),
        log.length === 0
          ? el('div', { class: 'empty' }, '目前沒有紀錄。')
          : UI.dataTable(
              el('thead', {}, el('tr', {}, el('th', {}, '時間'), el('th', {}, '動作'),
                el('th', {}, '筆數'), el('th', {}, '釋放空間'), el('th', {}, '執行者'), el('th', {}, '明細'))),
              el('tbody', {}, log.map((r) => el('tr', {},
                el('td', { class: 'small' }, UI.fmtDate(r.created_at)),
                el('td', {}, r.action),
                el('td', {}, String(r.affected)),
                el('td', {}, fmtBytes(r.freed_bytes)),
                el('td', { class: 'small' }, r.actor || '—'),
                el('td', { class: 'small muted' },
                  Array.isArray(r.detail)
                    ? r.detail.map((d) => (typeof d === 'string' ? d : `${d.action} ${d.count}`)).join('、')
                    : JSON.stringify(r.detail || '').slice(0, 120))))))));
    },
  };

  // ══ 口說即時監看 ══════════════════════════════════════════
  let monitorTimer = null;
  /** 換頁或登出時要停掉所有輪詢，否則會一直打 API（登出後還會噴 403）*/
  function stopPolling() {
    clearInterval(monitorTimer); monitorTimer = null;
    clearInterval(jobTimer); jobTimer = null;
    window.onbeforeunload = null;   // 離開題目編輯器時把「未儲存」提醒收掉
  }

  /** 考前環境檢查：誰測過、誰有問題 */
  async function deviceChecks() {
    const box = el('div', {}, UI.loading('讀取檢查紀錄…', 2));
    const url = new URL(location.origin);
    url.hash = '#/check';
    const link = url.toString();

    (async () => {
      let d;
      try { d = await API.get('/check/list?limit=100'); }
      catch (e) { return UI.render(box, UI.errorState(e.message)); }
      const bad = d.items.filter((x) => !x.ok);
      UI.render(box,
        el('p', { class: 'small muted' },
          '把這個網址發給學生，他們',
          el('b', {}, '不用登入'),
          '就能自己測：',
          el('code', { style: { userSelect: 'all', marginLeft: '.3rem' } }, link),
          el('button', {
            class: 'btn sm', style: { marginLeft: '.4rem' },
            onclick: () => navigator.clipboard?.writeText(link)
              .then(() => toast('已複製網址', 'ok')).catch(() => UI.alert(link)),
          }, '複製')),
        d.items.length === 0
          ? UI.emptyState('還沒有人做過考前環境檢查', null, '學生打開上面的網址跑一次就會出現在這裡。')
          : el('div', {},
              el('p', { class: 'small' },
                `最近 ${d.items.length} 筆　`,
                bad.length
                  ? el('span', { class: 'pill warn' }, `${bad.length} 台電腦有問題`)
                  : el('span', { class: 'pill ok' }, '全部通過')),
              UI.dataTable(
                el('thead', {}, el('tr', {},
                  el('th', {}, '時間'), el('th', {}, '學生'), el('th', {}, '班級'),
                  el('th', {}, '結果'), el('th', {}, '問題'), el('th', {}, '診斷碼'))),
                el('tbody', {}, d.items.map((x) => el('tr', {},
                  el('td', { class: 'small muted' }, fmtDate(x.created_at)),
                  el('td', {}, x.user_name || el('span', { class: 'muted' }, '未登入'),
                    x.username ? el('span', { class: 'small muted' }, `　${x.username}`) : null),
                  el('td', { class: 'small muted' }, x.class_group || '—'),
                  el('td', {}, x.ok
                    ? el('span', { class: 'pill ok' }, '通過')
                    : el('span', { class: 'pill warn' }, `${x.score} 分`)),
                  el('td', { class: 'small' }, x.summary || ''),
                  el('td', { class: 'small' }, el('code', { style: { userSelect: 'all' } }, x.code))))))));
    })();

    return el('div', { class: 'card' }, el('h3', {}, '🩺 考前環境檢查'), box);
  }

  async function monitor(mount) {
    stopPolling();
    const box = el('div');
    UI.render(mount,
      el('div', { class: 'toolbar' },
        el('h2', { style: { margin: 0 } }, '口說即時監看'),
        el('span', { class: 'pill info' }, '每 4 秒自動更新')),
      el('p', { class: 'small muted' }, '顯示最近 2 小時內進行過口說測驗的學生，以及 AI 考官給出的即時分數與逐字稿。'),
      box,
      await deviceChecks());

    const L = { FC: '流利', LR: '詞彙', GRA: '文法', PRO: '發音' };
    async function load() {
      let d;
      try { d = await API.get('/speaking/monitor/active'); } catch { return; }
      UI.render(box, d.sessions.length === 0
        ? el('div', { class: 'card' }, el('div', { class: 'empty' }, '目前沒有進行中的口說測驗。'))
        : d.sessions.map((s) => el('div', { class: 'card' },
            el('div', { style: { display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' } },
              el('div', { style: { flex: '1 1 240px' } },
                el('h3', { style: { margin: 0, border: 'none', padding: 0 } }, s.student_name,
                  el('span', { class: 'small muted' }, `　${s.class_group || ''}`)),
                el('div', { class: 'small muted' }, s.test_title, ' · ', UI.fmtDate(s.updated_at)),
                el('div', { class: 'small' },
                  el('span', { class: `pill ${s.status === 'final' ? 'ok' : 'warn'}` },
                    s.status === 'final' ? '已完成' : '進行中'),
                  `　Part ${s.part || 1}　已回答 ${s.turns} 輪`)),
              el('div', { style: { textAlign: 'right' } },
                el('div', { class: 'small muted' }, '即時總分'),
                el('div', { style: { fontSize: '2rem', fontWeight: '700', color: 'var(--brand)' } }, band(s.band)))),
            s.criteria ? el('div', { style: { marginTop: '.6rem' } },
              Object.entries(L).map(([k, lab]) => el('div', { class: 'crit-bar' },
                el('span', { class: 'lbl small' }, lab),
                el('span', { class: 'meter' }, el('i', { style: { width: `${((Number(s.criteria[k]) || 0) / 9) * 100}%` } })),
                el('span', { class: 'val small' }, String(s.criteria[k] ?? '—'))))) : null,
            s.notes ? el('p', { class: 'small' }, el('b', {}, '即時評語：'), s.notes) : null,
            el('div', { class: 'toolbar', style: { marginTop: '.5rem' } },
              el('button', {
                class: 'btn sm',
                onclick: async () => {
                  const r = await API.get(`/speaking/${s.attempt_id}/live`);
                  UI.modal({
                    title: `${s.student_name} 的逐字稿`, width: '760px',
                    body: el('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '.85rem', lineHeight: '1.7' } },
                      r.live?.transcript || '（尚無逐字稿）'),
                    actions: [{ label: '關閉', value: true }],
                  });
                },
              }, '看逐字稿'),
              el('a', { class: 'btn sm', href: `#/result/${s.attempt_id}` }, '看成績')))));
    }
    load();
    monitorTimer = setInterval(load, 4000);
  }

  /* ═══════════════════════════════════════════════════════════
     題庫 —— AI 出題、匯入、手動建立的題組都收在這裡重複使用
     ═══════════════════════════════════════════════════════════ */
  const BANK_TYPE_LABEL = {
    mcq_single: '單選', mcq_multi: '多選', tfng: 'True/False/Not Given',
    ynng: 'Yes/No/Not Given', matching: '配對', matching_headings: '標題配對',
    gap_fill: '填空', gap_fill_bank: '選字填空', short_answer: '簡答',
    label_image: '圖表標示', writing_task: '寫作題', speaking_part: '口說題組',
  };
  const BANK_SOURCE_LABEL = { ai: 'AI 產生', import: '匯入', manual: '手動' };

  async function bank(mount) {
    const filter = { module: '', type: '', source: '', q: '' };
    const selected = new Set();

    const box = el('div');
    const counter = el('span', { class: 'small muted' });
    const bar = el('div', { class: 'filterbar' });
    const typeSel = el('select', {
      onchange: (e) => { filter.type = e.target.value; load(); },
    }, el('option', { value: '' }, '全部題型'));

    const search = el('input', {
      type: 'search', placeholder: '搜尋主題、標籤或題目內容…',
      oninput: UI.debounce((e) => { filter.q = e.target.value.trim(); load(); }, 300),
    });

    async function load() {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(filter)) if (v) qs.set(k, v);
      let d;
      try { d = await API.get(`/ai/bank?${qs}`); }
      catch (e) { UI.render(box, UI.errorState(e.message, load)); return; }

      const stats = d.stats || [];
      counter.textContent = `題庫共 ${d.total} 個題組`
        + (d.items.length !== d.total ? `，目前顯示 ${d.items.length} 個` : '');

      // 題型下拉依目前科目動態帶出（只列真的有東西的題型）
      const avail = [...new Set(stats
        .filter((s) => !filter.module || s.module === filter.module)
        .map((s) => s.type))];
      const keep = filter.type;
      UI.render(typeSel, [el('option', { value: '' }, '全部題型')]
        .concat(avail.map((t) => el('option', { value: t, selected: t === keep },
          BANK_TYPE_LABEL[t] || t))));
      if (keep && !avail.includes(keep)) { filter.type = ''; typeSel.value = ''; }

      // 選取狀態只保留還在畫面上的
      const visible = new Set(d.items.map((i) => i.id));
      [...selected].forEach((id) => { if (!visible.has(id)) selected.delete(id); });
      renderBar(d.items);

      if (!d.items.length) {
        UI.render(box, el('div', { class: 'empty' },
          d.total === 0
            ? el('div', {},
                el('p', {}, '題庫還是空的。'),
                el('p', { class: 'small muted' },
                  '到「AI 出題」產生題組後按「存進題庫」，或在「匯入題目」把整份試卷的題組收進來，就會出現在這裡。'),
                el('a', { class: 'btn primary sm', href: '#/admin/generate' }, '去 AI 出題 →'))
            : '沒有符合條件的題組。'));
        return;
      }

      UI.render(box, UI.dataTable(
        el('thead', {}, el('tr', {},
          el('th', { style: { width: '2.2rem' } }, el('input', {
            type: 'checkbox',
            checked: d.items.every((i) => selected.has(i.id)),
            onchange: (e) => {
              selected.clear();
              if (e.target.checked) d.items.forEach((i) => selected.add(i.id));
              load();
            },
          })),
          el('th', {}, '主題 / 標籤'), el('th', {}, '科目'), el('th', {}, '題型'),
          el('th', {}, '題數'), el('th', {}, '難度'), el('th', {}, '來源'),
          el('th', {}, '建立'), el('th', {}, ''))),
        el('tbody', {}, d.items.map((it) => el('tr', { class: it.broken ? 'warn-row' : '' },
          el('td', {}, el('input', {
            type: 'checkbox', checked: selected.has(it.id),
            onchange: (e) => {
              if (e.target.checked) selected.add(it.id); else selected.delete(it.id);
              renderBar(d.items);
            },
          })),
          el('td', {},
            el('b', {}, it.topic || el('span', { class: 'muted' }, '（未命名）')),
            it.tags ? el('div', { class: 'small muted' }, it.tags) : null,
            it.broken ? el('div', { class: 'small', style: { color: 'var(--err)' } }, '資料損毀，建議刪除') : null),
          el('td', { class: 'small' }, (UI.MODULE_LABEL[it.module] || it.module).split(' ')[0]),
          el('td', { class: 'small' }, BANK_TYPE_LABEL[it.type] || it.type),
          el('td', { class: 'small' }, it.questionCount ? `${it.questionCount} 題` : '—'),
          el('td', { class: 'small' }, it.difficulty || '—'),
          el('td', { class: 'small' }, BANK_SOURCE_LABEL[it.source] || it.source),
          el('td', { class: 'small muted' },
            fmtDate(it.created_at), it.creator ? el('div', {}, it.creator) : null),
          el('td', { style: { whiteSpace: 'nowrap' } },
            el('button', { class: 'btn sm', onclick: () => bankPreview(it.id, load) }, '預覽'),
            ' ',
            el('button', { class: 'btn sm', onclick: () => bankEditTags(it, load) }, '標籤'),
            ' ',
            el('button', {
              class: 'btn sm danger',
              onclick: async () => {
                if (!await UI.confirm(el('div', {},
                  el('p', {}, `確定要刪除題組「${it.topic || it.type}」？`),
                  el('p', { class: 'small muted' }, '已經放進試卷的題目不會受影響。')), '刪除')) return;
                await API.del(`/ai/bank/${it.id}`);
                selected.delete(it.id);
                toast('已刪除', 'ok'); load();
              },
            }, '刪除')))))));
    }

    function renderBar(items) {
      const n = selected.size;
      UI.render(bar,
        el('select', {
          onchange: (e) => { filter.module = e.target.value; filter.type = ''; load(); },
        }, [['', '全部科目'], ['listening', '聽力'], ['reading', '閱讀'], ['writing', '寫作'], ['speaking', '口說']]
          .map(([v, l]) => el('option', { value: v, selected: filter.module === v }, l))),
        typeSel,
        el('select', {
          onchange: (e) => { filter.source = e.target.value; load(); },
        }, [['', '全部來源'], ['ai', 'AI 產生'], ['import', '匯入'], ['manual', '手動']]
          .map(([v, l]) => el('option', { value: v, selected: filter.source === v }, l))),
        search,
        el('span', { style: { flex: '1' } }),
        n ? el('span', { class: 'small' }, el('b', {}, `已選 ${n} 個`)) : null,
        n ? el('button', { class: 'btn primary sm', onclick: () => bankToTest([...selected], load) }, '加入試卷') : null,
        n ? el('button', {
          class: 'btn sm danger',
          onclick: async () => {
            if (!await UI.confirm(`確定要刪除選取的 ${n} 個題組？`, '刪除')) return;
            await API.post('/ai/bank/bulk-delete', { ids: [...selected] });
            selected.clear(); toast(`已刪除 ${n} 個題組`, 'ok'); load();
          },
        }, '刪除') : null);
      // renderBar 會重畫 select，把目前值補回去
      typeSel.value = filter.type;
      search.value = filter.q;
    }

    UI.render(mount,
      el('div', { class: 'toolbar' },
        el('h2', { style: { margin: 0 } }, '題庫'),
        counter,
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', onclick: () => autoAssemble(load) }, '🎲 自動組卷'),
        el('a', { class: 'btn', href: '#/admin/import' }, '＋ 匯入題目'),
        el('a', { class: 'btn primary', href: '#/admin/generate' }, '✨ AI 出題')),
      el('p', { class: 'small muted' },
        '題組存在這裡可以重複使用：勾選後按「加入試卷」就能併進現有試卷，或直接組成一份新試卷。'),
      el('div', { class: 'card' }, bar, box));

    load();
  }

  /* ── 自動組卷 ────────────────────────────────────────
     依目標題數從題庫抽題。先讓老師看到「題庫夠不夠」，
     再預覽組出來的結果，確認了才存成試卷。 */
  async function autoAssemble(reload) {
    let cov;
    try { cov = await API.get('/ai/bank/coverage'); }
    catch (e) { return UI.alert(e.message); }

    if (!cov.total) {
      return UI.alert(el('div', {},
        el('p', {}, '題庫是空的，沒有東西可以組。'),
        el('p', { class: 'small muted' }, '先到「AI 出題」產生題組並按「存進題庫」，或在「匯入題目」把整份試卷的題組收進來。')),
      '題庫是空的');
    }

    const f = {};
    const MODS = [
      ['listening', '聽力', 40],
      ['reading', '閱讀', 40],
      ['writing', '寫作', 2],
      ['speaking', '口說', 1],
    ];

    // 題庫現況：每一科有多少題、夠不夠
    const covRows = MODS.map(([m, label, want]) => {
      const c = cov.coverage[m];
      const have = c?.questions || 0;
      const enough = have >= want;
      return el('div', { class: 'inline', style: { padding: '.25rem 0' } },
        el('b', { style: { minWidth: '3.5rem', display: 'inline-block' } }, label),
        el('span', { class: 'small' }, `題庫有 ${have} 題`),
        el('span', { class: `pill ${enough ? 'ok' : 'warn'}` },
          enough ? '足夠' : have ? `還差 ${want - have} 題` : '沒有題目'),
        c ? el('span', { class: 'small muted' },
          Object.entries(c.byType).map(([t, n]) => `${TYPE_SHORT[t] || t} ${n}`).join('、')) : null);
    });

    const diffs = new Set();
    Object.values(cov.coverage).forEach((c) =>
      Object.keys(c.byDifficulty || {}).forEach((d) => diffs.add(d)));

    const body = el('div', {},
      el('div', { class: 'card', style: { background: '#fafafa', marginBottom: '.8rem' } },
        el('h4', {}, '題庫現況'), covRows),
      el('label', { class: 'field' }, el('span', {}, '試卷名稱'),
        (f.title = el('input', { type: 'text', value: `自動組卷 ${new Date().toISOString().slice(0, 10)}` }))),
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', {}, '類型'),
          (f.testType = el('select', {},
            el('option', { value: 'academic' }, 'Academic'),
            el('option', { value: 'general' }, 'General Training')))),
        el('label', { class: 'field' }, el('span', {}, '難度（湊不夠時會自動放寬）'),
          (f.difficulty = el('select', {},
            el('option', { value: '' }, '不限'),
            [...diffs].sort().map((d) => el('option', { value: d }, d)))))),
      el('div', { class: 'row' }, MODS.map(([m, label, want]) =>
        el('label', { class: 'field' }, el('span', {}, `${label}題數`),
          (f[m] = el('input', {
            type: 'number', min: 0, max: 100,
            value: (cov.coverage[m]?.questions || 0) > 0 ? want : 0,
          }))))),
      el('p', { class: 'small muted' }, '填 0 = 這一科不放。組出來的題號會自動重新編成連續的 1、2、3…'));

    const go = await UI.modal({
      title: '自動組卷',
      width: '720px',
      body,
      actions: [{ label: '產生預覽', value: true, class: 'primary' }, { label: '取消', value: false }],
    });
    if (!go) return;

    const payload = {
      title: f.title.value.trim(),
      testType: f.testType.value,
      difficulty: f.difficulty.value,
      targets: Object.fromEntries(MODS.map(([m]) => [m, Number(f[m].value) || 0])),
    };

    let r;
    try { r = await API.post('/ai/bank/auto', payload); }
    catch (e) { return UI.alert(e.details?.report ? shortfallText(e.details.report) : e.message, '組不出來'); }

    const rep = r.report || {};
    const save = await UI.modal({
      title: r.ok ? '預覽：組好了' : '預覽：有格式問題',
      width: '720px',
      body: el('div', {},
        el('p', {}, el('b', {}, r.paper.title)),
        el('p', { class: 'small' },
          `聽力 ${r.stats.listening} 題　閱讀 ${r.stats.reading} 題　`
          + `寫作 ${r.stats.writingTasks} 篇　口說 ${r.stats.speakingParts} 部分`),
        Object.keys(rep.picked || {}).length
          ? el('div', {}, Object.entries(rep.picked).map(([m, p]) =>
              el('div', { class: 'small', style: { padding: '.2rem 0' } },
                el('b', {}, UI.MODULE_LABEL[m]?.split(' ')[0] || m),
                `　抽了 ${p.groups} 個題組、${p.questions} 題`,
                p.typeMix?.length
                  ? el('span', { class: 'muted' },
                      `（${p.typeMix.map((t) => `${TYPE_SHORT[t.type] || t.type}×${t.groups}`).join('、')}）`)
                  : null)))
          : null,
        Object.keys(rep.shortfall || {}).length
          ? el('div', { class: 'small', style: { color: 'var(--warn)', marginTop: '.5rem' } },
              el('b', {}, '題庫不夠，這幾科沒湊滿：'), shortfallText(rep))
          : null,
        rep.relaxed?.length
          ? el('p', { class: 'small muted' },
              `${rep.relaxed.map((m) => UI.MODULE_LABEL[m]?.split(' ')[0]).join('、')} 的指定難度題目不夠，已放寬成不限難度。`)
          : null,
        r.errors?.length
          ? el('ul', { class: 'small' }, r.errors.slice(0, 8).map((x) => el('li', { style: { color: 'var(--err)' } }, x)))
          : null,
        r.warnings?.length
          ? el('details', {}, el('summary', { class: 'small muted' }, `提醒 ${r.warnings.length} 則`),
              el('ul', { class: 'small muted' }, r.warnings.map((x) => el('li', {}, x))))
          : null,
        el('p', { class: 'small muted', style: { marginTop: '.6rem' } },
          '存成草稿試卷後，記得到「題目」檢查，並到「素材」補上聽力音檔。')),
      actions: [
        ...(r.ok ? [{ label: '存成試卷', value: 'save', class: 'primary' }] : []),
        { label: '換一組再試', value: 'again' },
        { label: '關閉', value: false },
      ],
    });

    if (save === 'again') return autoAssemble(reload);
    if (save !== 'save') return;

    try {
      const saved = await API.post('/ai/bank/auto', { ...payload, save: true });
      toast('已存成草稿試卷', 'ok');
      await warnIfMissingMedia(saved.warnings);
      location.hash = '#/admin/tests';
      if (reload) reload();
    } catch (e) {
      UI.alert(e.details?.errors?.join('\n') || e.message);
    }
  }

  function shortfallText(rep) {
    return Object.entries(rep.shortfall || {})
      .map(([m, s]) => `${UI.MODULE_LABEL[m]?.split(' ')[0] || m}：只湊到 ${s.got}/${s.want} 題，還差 ${s.missing}`)
      .join('；');
  }

  /** 預覽一個題組的完整內容 */
  async function bankPreview(id, reload) {
    let item;
    try { ({ item } = await API.get(`/ai/bank/${id}`)); }
    catch (e) { return UI.alert(`讀不到這個題組：${e.message}`); }

    const p = item.payload || {};
    const g = p.group || (p.groups && p.groups[0]);
    const qs = g?.questions || [];

    const body = el('div', {},
      el('div', { class: 'small muted', style: { marginBottom: '.6rem' } },
        `${(UI.MODULE_LABEL[item.module] || item.module).split(' ')[0]} · `
        + `${BANK_TYPE_LABEL[item.type] || item.type} · ${qs.length} 題`
        + (item.difficulty ? ` · ${item.difficulty}` : '')),
      g?.instructions ? el('p', { class: 'instructions' }, g.instructions) : null,
      p.passageTitle ? el('h4', {}, p.passageTitle) : null,
      p.passage ? el('details', {},
        el('summary', {}, '文章內容'),
        el('div', { class: 'passage-preview', style: { whiteSpace: 'pre-wrap', lineHeight: '1.8', marginTop: '.5rem' } },
          p.passage)) : null,
      p.transcript ? el('details', {},
        el('summary', {}, '聽力逐字稿'),
        el('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.8', marginTop: '.5rem' } }, p.transcript)) : null,
      g?.options?.length ? el('div', { class: 'small', style: { margin: '.5rem 0' } },
        el('b', {}, '選項：'), g.options.map((o, i) =>
          el('div', {}, `${o.key || String.fromCharCode(65 + i)}. ${o.text ?? o}`))) : null,
      el('ol', { class: 'qb-preview', style: { lineHeight: '1.8', paddingLeft: '1.4rem' } },
        qs.map((q) => el('li', { value: q.number || undefined },
          el('div', {}, q.prompt || q.text || '（無題幹）'),
          q.options?.length ? el('div', { class: 'small muted' },
            q.options.map((o, i) => `${o.key || String.fromCharCode(65 + i)}. ${o.text ?? o}`).join('　')) : null,
          el('div', { class: 'small', style: { color: 'var(--ok)' } },
            '答案：', (() => {
              const a = q.answers ?? q.answer;
              if (Array.isArray(a)) return a.length ? a.join('　/　') : '—';
              return a === undefined || a === null || a === '' ? '—' : String(a);
            })()),
          q.explanation ? el('div', { class: 'small muted' }, '解析：', q.explanation) : null))));

    const choice = await UI.modal({
      title: item.topic || `題組 #${item.id}`,
      width: '820px',
      body,
      actions: [
        { label: '加入試卷', value: 'add', class: 'primary' },
        { label: '下載 JSON', value: 'json' },
        { label: '關閉', value: null },
      ],
    });
    if (choice === 'add') bankToTest([item.id], reload);
    if (choice === 'json') UI.download(`bank-${item.id}.json`, JSON.stringify(p, null, 2));
  }

  /** 改主題 / 難度 / 標籤 */
  async function bankEditTags(it, reload) {
    const topic = el('input', { type: 'text', value: it.topic || '' });
    const difficulty = el('input', { type: 'text', value: it.difficulty || '', placeholder: '例：band 6-7' });
    const tags = el('input', { type: 'text', value: it.tags || '', placeholder: '用逗號分隔，例：環境,圖表' });

    const ok = await UI.modal({
      title: '編輯題組資訊',
      body: el('div', {},
        el('label', { class: 'field' }, el('span', {}, '主題'), topic),
        el('label', { class: 'field' }, el('span', {}, '難度'), difficulty),
        el('label', { class: 'field' }, el('span', {}, '標籤'), tags)),
      actions: [{ label: '儲存', value: true, class: 'primary' }, { label: '取消', value: false }],
    });
    if (!ok) return;
    await API.put(`/ai/bank/${it.id}`, {
      topic: topic.value.trim(), difficulty: difficulty.value.trim(), tags: tags.value.trim(),
    });
    toast('已更新', 'ok'); reload();
  }

  /** 把選取的題組併進現有試卷，或組成新試卷 */
  async function bankToTest(ids, reload) {
    let tests = [];
    try { tests = (await API.get('/tests')).tests || []; } catch { tests = []; }

    const target = el('select', {}, [el('option', { value: '' }, '── 建立一份新試卷 ──')]
      .concat(tests.map((t) => el('option', { value: String(t.id) },
        `${t.title}${t.published ? '' : '（草稿）'}`))));
    const title = el('input', { type: 'text', value: '題庫組卷', placeholder: '新試卷名稱' });
    const titleField = el('label', { class: 'field' }, el('span', {}, '新試卷名稱'), title);
    target.onchange = () => { titleField.style.display = target.value ? 'none' : ''; };

    const ok = await UI.modal({
      title: `把 ${ids.length} 個題組加入試卷`,
      body: el('div', {},
        el('label', { class: 'field' }, el('span', {}, '加到哪一份試卷'), target),
        titleField,
        el('p', { class: 'small muted' },
          '同一科目的題組會依序接在既有 section 後面。題號如果重複，之後可以在試卷編輯裡調整。')),
      actions: [{ label: '加入', value: true, class: 'primary' }, { label: '取消', value: false }],
    });
    if (!ok) return;

    try {
      const r = await API.post('/ai/bank/to-test', {
        ids, testId: target.value ? Number(target.value) : 0, title: title.value.trim(),
      });
      await warnIfMissingMedia(r.warnings);
      toast(r.created ? `已建立新試卷（${r.added} 個題組）` : `已加入試卷（${r.added} 個題組）`, 'ok');
      if (reload) reload();
      location.hash = `#/admin/tests`;
    } catch (e) {
      UI.alert(e.details?.errors?.join('\n') || e.message);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     題目編輯器

     以前一題答案打錯，只能「匯出 JSON → 手改 → 重新匯入」。
     這裡直接在網頁上改題幹、選項、答案、解析、題號，存檔前會先驗證。
     ═══════════════════════════════════════════════════════════ */
  const TYPE_SHORT = {
    mcq_single: '單選', mcq_multi: '多選', tfng: 'T/F/NG', ynng: 'Y/N/NG',
    matching: '配對', gap_fill: '填空', gap_fill_bank: '選字填空',
    short_answer: '簡答', label_image: '圖表標示',
    writing_task: '寫作題', speaking_part: '口說題組',
  };

  const ANSWER_HINT = {
    letter: '填選項代號，例如 B',
    letters: '多個代號用逗號分隔，例如 B,D',
    enum: null,           // 依題型帶入下拉
    text: '多種寫法用 // 分隔；括號代表可有可無，例如 (the) north gate',
    mixed: '文字或選項代號皆可',
  };

  async function editPaper(mount, id) {
    UI.render(mount, UI.loading('載入試卷內容…', 6));
    let d;
    try { d = await API.get(`/tests/${id}`); }
    catch (e) { return UI.render(mount, UI.errorState(e.message, () => editPaper(mount, id))); }

    const { types } = await API.get('/tests/question-types');
    const paper = d.paper;
    let dirty = false;
    const touch = () => { dirty = true; status.textContent = '有未儲存的變更'; status.className = 'small'; };

    const status = el('span', { class: 'small muted' }, '');
    const body = el('div');

    window.onbeforeunload = () => (dirty ? '還有沒儲存的變更' : undefined);

    // ── 小工具 ──────────────────────────────────────────
    const field = (label, input, hint) => el('label', { class: 'field' },
      el('span', {}, label), input,
      hint ? el('span', { class: 'small muted' }, hint) : null);

    const textInput = (val, onchange, attrs = {}) => el('input', {
      type: 'text', value: val ?? '', ...attrs,
      oninput: (e) => { onchange(e.target.value); touch(); },
    });

    const areaInput = (val, onchange, rows = 3) => el('textarea', {
      rows, oninput: (e) => { onchange(e.target.value); touch(); },
    }, val ?? '');

    /** 選項編輯（A/B/C…） */
    function optionsEditor(holder, list, onChange) {
      const draw = () => UI.render(holder,
        el('div', { class: 'small muted', style: { marginBottom: '.3rem' } }, '選項'),
        (list || []).map((o, i) => el('div', {
          style: { display: 'flex', gap: '.4rem', marginBottom: '.3rem', alignItems: 'center' },
        },
          el('input', {
            type: 'text', value: o.key || '', style: { width: '3.5rem', flex: '0 0 3.5rem' },
            oninput: (e) => { o.key = e.target.value; touch(); },
          }),
          el('input', {
            type: 'text', value: o.text || '', style: { flex: '1' },
            oninput: (e) => { o.text = e.target.value; touch(); },
          }),
          el('button', {
            class: 'btn sm danger', type: 'button',
            onclick: () => { list.splice(i, 1); onChange(list); touch(); draw(); },
          }, '✕'))),
        el('button', {
          class: 'btn sm', type: 'button',
          onclick: () => {
            list.push({ key: String.fromCharCode(65 + list.length), text: '' });
            onChange(list); touch(); draw();
          },
        }, '＋ 新增選項'));
      draw();
    }

    /** 一題 */
    function questionRow(g, q, qi, redraw) {
      const meta = types[g.type] || {};
      const kind = meta.answerKind;
      // 沒設答案時一定要有一個空選項。否則下拉會「看起來」選了第一個值，
      // 但 q.answers 其實還是空的，存檔才跳「沒有標準答案」，老師完全看不懂。
      const cur = (q.answers || [])[0];
      const answerCell = kind === 'enum'
        ? el('select', {
            style: cur ? {} : { borderColor: 'var(--err)' },
            onchange: (e) => {
              q.answers = e.target.value ? [e.target.value] : [];
              e.target.style.borderColor = e.target.value ? '' : 'var(--err)';
              touch();
            },
          },
            el('option', { value: '', selected: !cur }, '（請選擇答案）'),
            (meta.enumValues || []).map((v) =>
              el('option', { value: v, selected: cur === v }, v)))
        : textInput((q.answers || []).join(' // '), (v) => {
            q.answers = v.split('//').map((x) => x.trim()).filter(Boolean);
          }, { placeholder: ANSWER_HINT[kind] || '' });

      const perQOptions = el('div');
      if (g.type === 'mcq_single') {
        q.options = q.options || [];
        optionsEditor(perQOptions, q.options, (l) => { q.options = l; });
      }

      return el('div', {
        style: {
          border: '1px solid var(--line-2)', borderRadius: '4px',
          padding: '.6rem .7rem', marginBottom: '.5rem', background: '#fff',
        },
      },
        el('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center', marginBottom: '.4rem' } },
          el('span', { class: 'small muted' }, '題號'),
          el('input', {
            type: 'number', value: q.number ?? '', style: { width: '5rem' },
            oninput: (e) => { q.number = Number(e.target.value) || null; touch(); },
          }),
          el('span', { style: { flex: 1 } }),
          el('button', {
            class: 'btn sm danger', type: 'button',
            onclick: async () => {
              if (!await UI.confirm(`刪除第 ${q.number} 題？`, '刪除')) return;
              g.questions.splice(qi, 1); touch(); redraw();
            },
          }, '刪除這一題')),
        field('題幹', areaInput(q.text ?? q.prompt ?? '', (v) => { q.text = v; delete q.prompt; }, 2)),
        g.type === 'mcq_single' ? perQOptions : null,
        field('標準答案', answerCell, kind === 'enum' ? null : ANSWER_HINT[kind]),
        field('解析（只有老師和成績單看得到）', areaInput(q.explanation || '', (v) => { q.explanation = v; }, 2)));
    }

    /** 整份試卷目前最大的題號 —— 新增題目時用，免得一加就撞號 */
    function maxNumberInPaper() {
      let max = 0;
      for (const m of paper.modules) {
        for (const s2 of m.sections || []) {
          for (const g2 of s2.groups || []) {
            for (const q2 of g2.questions || []) {
              const n = Number(q2.number);
              if (Number.isFinite(n) && n > max) max = n;
            }
          }
        }
      }
      return max;
    }

    /** 把某一科的客觀題重新依順序編號 —— 插題刪題之後很需要 */
    function renumberModule(mod) {
      let n = 0;
      for (const sec of mod.sections || []) {
        for (const g of sec.groups || []) {
          if (!types[g.type]?.objective) continue;
          for (const q of g.questions || []) { n += 1; q.number = n; }
        }
      }
      return n;
    }

    /** 一個題組 */
    function groupCard(sec, g, gi, redraw) {
      const meta = types[g.type] || {};
      const qHolder = el('div');
      const drawQs = () => UI.render(qHolder,
        (g.questions || []).map((q, qi) => questionRow(g, q, qi, () => { drawQs(); })),
        el('button', {
          class: 'btn sm', type: 'button',
          onclick: () => {
            g.questions.push({
              number: maxNumberInPaper() + 1, text: '', answers: [], explanation: '',
              ...(g.type === 'mcq_single' ? { options: [] } : {}),
            });
            touch(); drawQs();
          },
        }, '＋ 新增題目'));
      drawQs();

      const groupOptions = el('div');
      if (meta.needsOptions || (g.options && g.options.length)) {
        g.options = g.options || [];
        optionsEditor(groupOptions, g.options, (l) => { g.options = l; });
      }

      return el('div', {
        class: 'card',
        style: { background: '#fafafa', marginBottom: '.8rem' },
      },
        el('div', { class: 'toolbar', style: { marginBottom: '.5rem' } },
          el('b', {}, meta.label || g.type),
          el('span', { class: 'small muted' }, `　${(g.questions || []).length} 題`),
          el('span', { style: { flex: 1 } }),
          el('button', {
            class: 'btn sm danger', type: 'button',
            onclick: async () => {
              if (!await UI.confirm(`刪除整個「${meta.label || g.type}」題組？裡面 ${(g.questions || []).length} 題會一起消失。`, '刪除')) return;
              sec.groups.splice(gi, 1); touch(); redraw();
            },
          }, '刪除題組')),
        field('指示語 Instructions', areaInput(g.instructions || '', (v) => { g.instructions = v; }, 2),
          '照官方寫法，例如 Write NO MORE THAN TWO WORDS AND/OR A NUMBER for each answer.'),
        el('div', { class: 'row' },
          meta.answerKind === 'text' || meta.supportsBody
            ? field('字數上限', el('input', {
                type: 'number', value: g.wordLimit ?? '', min: 1,
                oninput: (e) => { g.wordLimit = Number(e.target.value) || null; touch(); },
              })) : null,
          g.type === 'mcq_multi'
            ? field('要選幾個', el('input', {
                type: 'number', value: g.selectCount ?? 2, min: 2,
                oninput: (e) => { g.selectCount = Number(e.target.value) || 2; touch(); },
              })) : null,
          meta.needsImage || g.image
            ? field('圖片網址', textInput(g.image || '', (v) => { g.image = v || null; },
                { placeholder: '/uploads/image/…' })) : null),
        groupOptions,
        meta.supportsBody
          ? field('版面 bodyHtml（用 [[題號]] 當空格）',
              areaInput(g.bodyHtml || '', (v) => { g.bodyHtml = v || null; }, 5))
          : null,
        el('div', { style: { marginTop: '.6rem' } }, qHolder));
    }

    // ── 整頁 ────────────────────────────────────────────
    function draw() {
      UI.render(body, paper.modules.map((mod) => {
        const secHolder = el('div');
        const drawSecs = () => UI.render(secHolder, mod.sections.map((sec, si) => {
          const gHolder = el('div');
          const drawGroups = () => UI.render(gHolder,
            (sec.groups || []).map((g, gi) => groupCard(sec, g, gi, drawGroups)),
            el('div', { style: { display: 'flex', gap: '.4rem', flexWrap: 'wrap' } },
              Object.entries(types)
                .filter(([, t]) => t.modules.includes(mod.module))
                .map(([k, t]) => el('button', {
                  class: 'btn sm', type: 'button',
                  onclick: () => {
                    sec.groups.push({ type: k, instructions: '', questions: [], ...(t.needsOptions ? { options: [] } : {}) });
                    touch(); drawGroups();
                  },
                }, `＋ ${TYPE_SHORT[k] || t.label}`))));
          drawGroups();

          return el('details', { open: true, style: { marginBottom: '1rem' } },
            el('summary', {}, el('b', {}, sec.title || `第 ${si + 1} 節`),
              el('span', { class: 'small muted' },
                `　${(sec.groups || []).reduce((n, g) => n + (g.questions?.length || 0), 0)} 題`)),
            el('div', { style: { paddingLeft: '.6rem', paddingTop: '.5rem' } },
              field('這一節的標題', textInput(sec.title || '', (v) => { sec.title = v; })),
              gHolder,
              el('div', { style: { marginTop: '.6rem' } },
                el('button', {
                  class: 'btn sm danger', type: 'button',
                  onclick: async () => {
                    if (!await UI.confirm(`刪除整節「${sec.title}」？`, '刪除')) return;
                    mod.sections.splice(si, 1); touch(); drawSecs();
                  },
                }, '刪除這一節'))));
        }),
        el('button', {
          class: 'btn sm', type: 'button',
          onclick: () => {
            mod.sections.push({
              title: `${mod.module === 'reading' ? 'Reading Passage' : 'Section'} ${mod.sections.length + 1}`,
              groups: [],
            });
            touch(); drawSecs();
          },
        }, '＋ 新增一節'));
        drawSecs();

        return el('details', { open: true },
          el('summary', {}, el('b', {}, UI.MODULE_LABEL[mod.module] || mod.module),
            el('span', { class: 'small muted' }, `　${mod.sections.length} 節`)),
          el('div', { style: { paddingTop: '.6rem' } },
            ['listening', 'reading'].includes(mod.module)
              ? el('div', { style: { marginBottom: '.6rem' } },
                  el('button', {
                    class: 'btn sm', type: 'button',
                    onclick: async () => {
                      if (!await UI.confirm('把這一科的題目依目前順序重新編號 1、2、3…？插題刪題之後很好用，但既有成績是照題號對應的，已經考過的試卷請不要動。', '重新編號')) return;
                      const n = renumberModule(mod);
                      touch(); draw();
                      toast(`已重新編號 1–${n}`, 'ok');
                    },
                  }, '↻ 重新編號'),
                  el('span', { class: 'small muted' }, '　插題或刪題造成題號跳號時使用'))
              : null,
            secHolder));
      }));
    }

    async function save(publish) {
      status.textContent = '驗證中…';
      let v;
      try { v = await API.post('/tests/validate', { paper }); }
      catch (e) { status.textContent = `驗證失敗：${e.message}`; return; }
      if (!v.ok) {
        status.textContent = `有 ${v.errors.length} 個問題`;
        status.className = 'small';
        status.style.color = 'var(--err)';
        return UI.alert(el('div', {},
          el('p', {}, el('b', {}, '這樣存不進去，請先修正：')),
          el('ul', { class: 'small' }, v.errors.map((x) => el('li', {}, x)))), '格式有誤');
      }
      try {
        const r = await API.put(`/tests/${id}`, { paper, published: publish ?? d.test.published });
        dirty = false;
        status.style.color = '';
        status.textContent = `已儲存　聽力 ${r.stats.listening} 題　閱讀 ${r.stats.reading} 題`;
        toast('已儲存', 'ok');
        await warnIfMissingMedia(r.warnings);
      } catch (e) {
        status.style.color = 'var(--err)';
        status.textContent = `儲存失敗：${e.message}`;
        UI.alert(e.details?.errors?.join('\n') || e.message);
      }
    }

    UI.render(mount,
      el('div', { class: 'toolbar' },
        el('a', { class: 'btn sm', href: '#/admin/tests' }, '← 試卷管理'),
        el('h2', { style: { margin: 0 } }, '編輯題目'),
        el('span', { style: { flex: 1 } }),
        status,
        el('button', { class: 'btn', onclick: () => save() }, '驗證並儲存')),
      el('div', { class: 'card' },
        el('div', { class: 'row' },
          field('試卷標題', textInput(paper.title, (v) => { paper.title = v; })),
          field('類型', el('select', {
            onchange: (e) => { paper.testType = e.target.value; touch(); },
          },
            el('option', { value: 'academic', selected: paper.testType !== 'general' }, 'Academic'),
            el('option', { value: 'general', selected: paper.testType === 'general' }, 'General Training')))),
        field('說明', textInput(paper.description || '', (v) => { paper.description = v; })),
        el('p', { class: 'small muted' },
          '改完按「驗證並儲存」。驗證會檢查題號重複、答案是否合法、bodyHtml 的空格對不對得上。',
          el('br'),
          '文章、音檔、圖片請用試卷管理列的「素材」按鈕。')),
      body);

    draw();
  }

  return { tests, importPage, generate, bank, members, assign, results, settings, files, data, monitor, editPaper, stopPolling };
})();
