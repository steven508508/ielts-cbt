/* ═══════════════════════════════════════════════════════════
   成績單（仿官方 TRF）與逐題檢討報告
   ═══════════════════════════════════════════════════════════ */
const Results = (() => {
  const { el, sanitize, band, fmtDate } = UI;
  let D = null;
  let pollTimer = null;

  async function render(attemptId, mount) {
    clearInterval(pollTimer);
    UI.render(mount, UI.loading('載入成績單…', 5));
    try {
      D = await API.get(`/results/${attemptId}`);
    } catch (e) { return UI.render(mount, UI.errorState(e.message, () => render(attemptId, mount))); }

    if (['submitted', 'grading'].includes(D.attempt.status)) {
      renderGrading(attemptId, mount);
      return;
    }
    draw(mount, attemptId);
  }

  function renderGrading(attemptId, mount) {
    UI.render(mount, el('div', { class: 'card', style: { textAlign: 'center', padding: '3rem 1rem' } },
      el('h3', {}, '批改中…'),
      el('p', { class: 'muted' }, '聽力與閱讀已自動批改完成；寫作與口說的 AI 評分需要約 30–90 秒，請稍候。'),
      el('div', { class: 'progress', style: { maxWidth: '320px', margin: '1rem auto' } }, el('i', { style: { width: '35%' } })),
      el('button', { class: 'btn', onclick: () => render(attemptId, mount) }, '立即重新整理')));
    pollTimer = setInterval(async () => {
      try {
        const s = await API.get(`/exam/${attemptId}/status`);
        if (s.status === 'graded') { clearInterval(pollTimer); render(attemptId, mount); }
      } catch { clearInterval(pollTimer); }
    }, 5000);
  }

  function draw(mount, attemptId) {
    const tabs = [{ k: 'trf', label: '成績單' }];
    if (D.review.listening) tabs.push({ k: 'listening', label: '聽力檢討' });
    if (D.review.reading) tabs.push({ k: 'reading', label: '閱讀檢討' });
    if (D.writing?.length) tabs.push({ k: 'writing', label: '寫作批改' });
    if (D.speaking?.length) tabs.push({ k: 'speaking', label: '口說評分' });
    if (D.conduct && (D.conduct.events?.length || D.conduct.leaveCount)) {
      tabs.push({
        k: 'conduct',
        label: D.conduct.leaveCount ? `考試紀律 ⚠ ${D.conduct.leaveCount}` : '考試紀律',
      });
    }

    const bodyBox = el('div', { id: 'res-body' });
    const tabBar = el('div', { class: 'tabs no-print' }, tabs.map((t) =>
      el('button', {
        class: t.k === 'trf' ? 'active' : '',
        onclick: (e) => {
          [...tabBar.children].forEach((c) => c.classList.remove('active'));
          e.target.classList.add('active');
          UI.render(bodyBox, view(t.k, attemptId));
        },
      }, t.label)));

    UI.render(mount, 
      el('div', { class: 'toolbar no-print' },
        el('h2', { style: { margin: 0 } }, D.test.title),
        el('span', { class: 'spacer', style: { flex: 1 } }),
        el('button', { class: 'btn', onclick: () => window.print() }, '🖨 列印 / 存成 PDF'),
        API.user?.role !== 'student' && el('button', {
          class: 'btn', onclick: async () => {
            if (!(await UI.confirm('重新批改會覆蓋現有成績，確定嗎？'))) return;
            UI.toast('重新批改中…');
            try { await API.post(`/results/${attemptId}/regrade`, {}); UI.toast('完成', 'ok'); render(attemptId, mount); }
            catch (e) { UI.alert(e.message); }
          },
        }, '重新批改')),
      tabBar, bodyBox);
    UI.render(bodyBox, view('trf', attemptId));
  }

  function view(k, attemptId) {
    if (k === 'trf') return trf();
    if (k === 'listening' || k === 'reading') return objectiveReview(k);
    if (k === 'writing') return writingReview(attemptId);
    if (k === 'speaking') return speakingReview(attemptId);
    if (k === 'conduct') return conductReview();
    return el('div');
  }

  // ── 考試紀律（監考事件）────────────────────────────────
  const EVENT_LABEL = {
    module_start: ['開始作答', ''],
    leave: ['離開考試畫面', 'err'],
    return: ['回到考試畫面', ''],
    fullscreen_exit: ['離開全螢幕', 'err'],
    fullscreen_enter: ['進入全螢幕', ''],
    copy_blocked: ['嘗試複製題目（已擋下）', 'warn'],
    paste_blocked: ['嘗試貼上內容（已擋下）', 'warn'],
    auto_submit: ['違規次數超標，自動收卷', 'err'],
    resize: ['視窗大小改變', ''],
    devtools: ['疑似開啟開發者工具', 'warn'],
    device_permission: ['裝置權限問題', ''],
    device_check: ['考前環境檢查', ''],
  };

  const SEV_LABEL = { info: '紀錄', warn: '需留意', alert: '可疑' };

  function conductReview() {
    const c = D.conduct || { counts: {}, flagged: {}, events: [], bySeverity: {} };
    // 數字方塊要跟上面那句「有沒有異常」用同一套算法，
    // 不然會出現標題說 0 次、方塊卻紅字寫 1 的情況。
    const shown = c.flagged || c.counts || {};
    const isStaff = API.user?.role !== 'student';
    const suspicious = c.leaveCount || shown.copy_blocked || shown.paste_blocked;
    const excused = c.excusedCount || 0;

    return el('div', {},
      el('div', { class: 'card' },
        el('h3', {}, '考試紀律'),
        suspicious
          ? el('p', {}, '這場考試偵測到以下行為，僅供老師參考，系統不會自動判定作弊。')
          : el('p', {}, '這場考試沒有偵測到任何異常行為。'),
        // 裝置問題造成的離開單獨列出來。混在「離開次數」裡的話，
        // 老師看到的是一個看不出所以然的數字，很容易誤判成作弊。
        excused
          ? el('p', { class: 'small muted' },
              `另外有 ${excused} 次離開是系統判定為裝置問題（例如處理麥克風權限、或在不要求全螢幕的科目退出全螢幕），`,
              '不計入上面的次數。')
          : null,
        el('div', { class: 'row' }, Object.entries(shown).map(([k, n]) => {
          const [label, kind] = EVENT_LABEL[k] || [k, ''];
          if (['module_start', 'return', 'fullscreen_enter', 'device_check'].includes(k)) return null;
          return el('div', { style: { minWidth: '130px', flex: '0 0 auto' } },
            el('div', { class: 'small muted' }, label),
            el('div', {
              style: { fontSize: '1.6rem', fontWeight: '700', color: kind === 'err' ? 'var(--err)' : kind === 'warn' ? 'var(--warn)' : 'inherit' },
            }, String(n)));
        }))),

      isStaff && c.events?.length
        ? el('div', { class: 'card' },
            el('h3', {}, `事件時間軸（${c.events.length} 筆）`),
            UI.dataTable(
              el('thead', {}, el('tr', {}, el('th', {}, '時間'), el('th', {}, '科目'),
                el('th', {}, '等級'), el('th', {}, '事件'), el('th', {}, '備註'))),
              el('tbody', {}, c.events.map((e) => {
                const sev = e.severity || 'warn';
                const [label, kind] = EVENT_LABEL[e.type] || [e.type, ''];
                return el('tr', { style: sev === 'info' ? { opacity: '.65' } : {} },
                  el('td', { class: 'small muted' }, fmtDate(e.created_at)),
                  el('td', { class: 'small' }, e.module ? (UI.MODULE_LABEL[e.module] || e.module).split(' ')[0] : '—'),
                  el('td', {}, el('span', { class: `sev ${sev}` }, SEV_LABEL[sev] || sev)),
                  el('td', {}, el('span', { class: `pill ${sev === 'info' ? '' : kind}` }, label)),
                  el('td', { class: 'small muted' }, e.detail || ''));
              }))))
        : el('p', { class: 'small muted' }, isStaff ? '' : '完整的事件明細只有老師看得到。'));
  }

  // ── 成績單 ──────────────────────────────────────────────
  function trf() {
    const b = D.attempt.bands;
    const c = D.candidate;
    // 英文名字拆成 Family / Given；中文等沒有空格的名字就整個放在「姓名」欄
    const parts = String(c.name || '').trim().split(/\s+/);
    const splitName = parts.length > 1;
    const family = splitName ? parts[parts.length - 1].toUpperCase() : '';
    const given = splitName ? parts.slice(0, -1).join(' ') : '';

    const scoreCol = (label, value, showCefr = false) => el('div', { class: 'col' },
      el('div', { class: 'h' }, label),
      el('div', { class: 's' }, band(value)),
      el('div', { class: 'cefr' }, showCefr ? (D.attempt.cefr || '') : ' '));

    const cell = (k, v) => el('div', { class: 'cell' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v || '—'));

    return el('div', {},
      el('div', { class: 'trf' },
        el('div', { class: 'trf-head' },
          el('div', {},
            el('div', { class: 't1' }, 'Test Report Form'),
            el('div', { class: 't2' }, 'ACADEMIC / GENERAL TRAINING · 模擬測驗成績報告')),
          el('div', { class: 'mark' }, 'IELTS', el('div', { class: 'small muted', style: { fontWeight: '400' } }, 'Practice Simulation'))),

        el('div', { class: 'trf-grid' },
          splitName ? cell('Family Name', family) : cell('Name　姓名', c.name),
          splitName ? cell('Given Name', given) : cell('Login', c.username),
          cell('Candidate ID', c.candidate_no || c.username),
          cell('Date of Birth', c.date_of_birth || '—'),
          cell('Nationality', c.nationality || '—'),
          cell('Class / Centre', c.class_group || '—'),
          cell('Test Date', fmtDate(D.attempt.submittedAt || D.attempt.startedAt)),
          cell('Module', D.test.testType === 'general' ? 'General Training' : 'Academic')),

        el('div', { class: 'trf-scores' },
          scoreCol('LISTENING', b.listening),
          scoreCol('READING', b.reading),
          scoreCol('WRITING', b.writing),
          scoreCol('SPEAKING', b.speaking),
          scoreCol('OVERALL BAND SCORE', b.overall, true)),

        el('div', { class: 'trf-note' },
          el('b', {}, 'Administrator Comments　評語'), el('br'),
          D.attempt.bandSummary
            ? el('span', {}, `Band ${Math.floor(b.overall)} — ${D.attempt.bandSummary.en}。${D.attempt.bandSummary.zh}`)
            : el('span', { class: 'muted' }, '尚無評語'),
          el('div', { style: { marginTop: '.5rem' } },
            el('span', { class: 'muted' },
              'CEFR 對照：', el('b', {}, D.attempt.cefr || '—'),
              '　｜　聽力答對 ',
              D.moduleResults.listening ? `${D.moduleResults.listening.rawScore}/${D.moduleResults.listening.total}` : '—',
              '　閱讀答對 ',
              D.moduleResults.reading ? `${D.moduleResults.reading.rawScore}/${D.moduleResults.reading.total}` : '—'))),

        el('div', { class: 'trf-sign' },
          el('div', { class: 'box' }, 'Test Centre Stamp'),
          el('div', { class: 'box' }, 'Administrator Signature'),
          el('div', { class: 'box' }, `Date　${fmtDate(D.attempt.gradedAt || D.attempt.submittedAt)}`)),

        el('div', { class: 'trf-watermark' }, 'PRACTICE TEST — NOT AN OFFICIAL IELTS RESULT')),

      el('p', { class: 'small muted no-print', style: { textAlign: 'center', marginTop: '1rem' } },
        '本成績單為校內模擬考結果，僅供教學參考，非 IELTS 官方成績。原始分對照表可由老師在「系統設定」調整。'));
  }

  // ── 聽力／閱讀逐題檢討 ──────────────────────────────────
  function objectiveReview(mod) {
    const rows = D.review[mod] || [];
    const r = D.moduleResults[mod];
    const wrong = rows.filter((x) => !x.correct);

    // 依 sectionIndex 分組（用標題分的話，兩節同名就會被併在一起）
    const media = (D.reviewMedia || {})[mod] || [];
    const bySection = new Map();
    for (const q of rows) {
      const k = q.sectionIndex ?? q.section;
      if (!bySection.has(k)) bySection.set(k, { title: q.section, items: [] });
      bySection.get(k).items.push(q);
    }

    const typeStats = new Map();
    for (const q of rows) {
      const t = typeStats.get(q.type) || { n: 0, ok: 0 };
      t.n += 1; if (q.correct) t.ok += 1;
      typeStats.set(q.type, t);
    }

    return el('div', {},
      el('div', { class: 'card' },
        el('h3', {}, UI.MODULE_LABEL[mod]),
        el('p', {}, '答對 ', el('b', { style: { fontSize: '1.3rem' } }, `${r?.rawScore ?? 0}`), ` / ${r?.total ?? rows.length}`,
          '　→　Band ', el('b', { style: { fontSize: '1.3rem', color: 'var(--brand)' } }, band(r?.band))),
        el('div', { class: 'progress' }, el('i', { style: { width: `${((r?.rawScore || 0) / (r?.total || 1)) * 100}%` } })),
        el('h4', { style: { marginTop: '1rem' } }, '各題型正確率'),
        [...typeStats].map(([t, v]) => el('div', { class: 'crit-bar' },
          el('span', { class: 'lbl small' }, TYPE_LABEL[t] || t),
          el('span', { class: 'meter' }, el('i', { style: { width: `${(v.ok / v.n) * 100}%` } })),
          el('span', { class: 'val small' }, `${v.ok}/${v.n}`)))),

      wrong.length === 0
        ? el('div', { class: 'card' }, el('p', {}, '全部答對，太厲害了。'))
        : null,

      [...bySection].map(([k, sec]) => el('div', { class: 'card' },
        el('h3', {}, sec.title),
        // 檢討一定要能看到原文。只給題幹的話學生根本回想不起來當初在讀什麼。
        sourceBlock(media[Number(k)]),
        groupBy(sec.items).map((grp) => el('div', {},
          // 配合題／選字填空的選項是整組共用的，畫在題組上方一次就好
          grp.instructions ? el('div', { class: 'small muted', style: { margin: '.5rem 0 .2rem' } }, grp.instructions) : null,
          grp.sharedOptions ? optionList(grp.sharedOptions, grp.items) : null,
          grp.bodyHtml ? el('div', { class: 'rev-body small', html: sanitize(grp.bodyHtml) }) : null,
          grp.image ? el('img', { src: grp.image, class: 'rev-img', alt: '題組圖片', loading: 'lazy' }) : null,
          grp.items.map((q) => el('div', { class: `rev-q ${q.correct ? 'correct' : 'wrong'}` },
            el('div', { class: 'hd' },
              el('b', {}, `Q${q.number}`),
              el('span', { class: `pill ${q.correct ? 'ok' : 'err'}` }, q.correct ? '答對' : '答錯'),
              el('span', { class: 'muted small' }, TYPE_LABEL[q.type] || q.type)),
            q.text && el('div', { class: 'small', style: { marginBottom: '.3rem' }, html: sanitize(q.text) }),
            !grp.image && q.image
              ? el('img', { src: q.image, class: 'rev-img', alt: `Q${q.number} 圖片`, loading: 'lazy' }) : null,
            // 單選題的選項是每題自己的，就畫在題目底下
            !q.optionsShared && q.options?.length ? optionList(q.options, [q]) : null,
            el('div', { class: 'small' },
              '你的答案：', el('span', { class: 'yours' }, withText(q.response, q.options) || '（未作答）'),
              !q.correct
                ? el('span', {}, '　正解：',
                    el('b', {}, (q.answers || []).map((a) => withText(a, q.options)).join(' / ')))
                : null),
            q.explanation && el('div', { class: 'exp', html: sanitize(q.explanation) }))))))));
  }

  /**
   * 配合題的答案是 "ii" 這種字母，光看字母根本不知道選了什麼。
   * 有選項清單時把對應的文字補上去。
   */
  function withText(key, options) {
    const k = String(key ?? '').trim();
    if (!k || !options?.length) return k;
    const hit = options.find((o) => String(o.key).toUpperCase() === k.toUpperCase());
    return hit ? `${k}（${hit.text}）` : k;
  }

  /** 依題組切開，讓共用的選項清單只畫一次 */
  function groupBy(items) {
    const out = [];
    for (const q of items) {
      const last = out[out.length - 1];
      if (last && last.key === q.groupIndex) { last.items.push(q); continue; }
      out.push({
        key: q.groupIndex,
        instructions: q.instructions || '',
        sharedOptions: q.optionsShared ? q.options : null,
        bodyHtml: q.bodyHtml || null,
        image: q.optionsShared || !q.options ? q.image : null,
        items: [q],
      });
    }
    return out;
  }

  /**
   * 選項清單。答錯的時候要看得出「我選了哪個、正確的是哪個」——
   * 只印一排 A. B. C. 對檢討沒有幫助。
   */
  function optionList(options, forQuestions) {
    const chosen = new Set();
    const right = new Set();
    for (const q of forQuestions || []) {
      String(q.response || '').split(/[,\s]+/).filter(Boolean).forEach((x) => chosen.add(x.toUpperCase()));
      (q.answers || []).forEach((x) => right.add(String(x).toUpperCase()));
    }
    const single = (forQuestions || []).length === 1;
    return el('ul', { class: 'rev-opts' }, options.map((o) => {
      const k = String(o.key || '').toUpperCase();
      const isRight = single && right.has(k);
      const isMine = single && chosen.has(k);
      return el('li', { class: `${isRight ? 'right' : ''} ${isMine && !isRight ? 'mine' : ''}`.trim() },
        el('b', {}, `${o.key}.`), ' ', o.text,
        isRight ? el('span', { class: 'tag ok' }, '正解') : null,
        isMine && !isRight ? el('span', { class: 'tag err' }, '你選的') : null);
    }));
  }

  /** 這一節的文章／逐字稿／音檔。預設收起來，按一下展開對照。 */
  function sourceBlock(m) {
    if (!m || (!m.passage && !m.transcript && !m.audio)) return null;
    return el('details', { class: 'rev-src', open: true },
      el('summary', {},
        m.passage ? '📄 原文' : '🎧 聽力逐字稿',
        m.passageTitle ? el('span', { class: 'muted small' }, `　${m.passageTitle}`) : null),
      el('div', { class: 'rev-src-body' },
        m.audio ? el('audio', { src: m.audio, controls: true, preload: 'none', style: { width: '100%' } }) : null,
        m.passage ? el('div', { class: 'passage', html: sanitize(m.passage) }) : null,
        m.transcript ? el('pre', { class: 'transcript' }, m.transcript) : null));
  }

  const TYPE_LABEL = {
    mcq_single: '單選', mcq_multi: '多選', tfng: 'T/F/NG', ynng: 'Y/N/NG',
    matching: '配對', gap_fill: '填空', gap_fill_bank: '選字填空',
    short_answer: '簡答', label_image: '圖表標示',
  };

  // ── 寫作批改 ────────────────────────────────────────────
  function critBars(criteria, labels) {
    if (!criteria) return null;
    return el('div', {}, Object.entries(labels).map(([k, lab]) => {
      const v = Number(criteria[k]);
      if (Number.isNaN(v)) return null;
      return el('div', { class: 'crit-bar' },
        el('span', { class: 'lbl' }, lab.zh, el('span', { class: 'muted small' }, ` ${k}`)),
        el('span', { class: 'meter' }, el('i', { style: { width: `${(v / 9) * 100}%` } })),
        el('span', { class: 'val' }, v.toFixed(1)));
    }));
  }

  function writingReview(attemptId) {
    const labels = D.criteriaLabels.writing;
    const mr = D.moduleResults.writing;

    return el('div', {},
      el('div', { class: 'card' },
        el('h3', {}, '寫作總分 ', el('span', { style: { color: 'var(--brand)' } }, band(mr?.band))),
        el('p', { class: 'small muted' }, 'Task 2 的權重是 Task 1 的兩倍。'),
        critBars(mr?.criteria, labels)),

      (D.writing || []).map((w) => {
        const fb = w.feedback || {};
        return el('div', { class: 'card' },
          el('h3', {}, `Task ${w.taskNo}`, el('span', { class: 'pill info', style: { marginLeft: '.6rem' } }, `Band ${band(w.band)}`),
            el('span', { class: 'muted small', style: { marginLeft: '.6rem', fontWeight: '400' } },
              `${w.wordCount} 字（要求 ${w.minWords} 字）`)),

          w.prompt && el('details', { open: !!w.image, style: { marginBottom: '.8rem' } },
            el('summary', { class: 'small muted' }, '題目'),
            el('div', { class: 'bodyhtml small', html: sanitize(w.prompt) }),
            // Task 1 的圖表就是題目本身。沒有它，學生看著「描述下圖」四個字
            // 和一篇 Band 8 範文，完全不知道當初在描述什麼。
            w.image ? el('img', { src: w.image, class: 'rev-img', alt: `Task ${w.taskNo} 圖表`, loading: 'lazy' }) : null,
            !w.image && w.visualDescription
              ? el('div', { class: 'small muted', style: { marginTop: '.4rem' } },
                  '（這題沒有上傳圖檔，AI 出題時的圖表描述：', w.visualDescription, '）')
              : null),

          el('details', { open: true, style: { marginBottom: '.8rem' } },
            el('summary', { class: 'small muted' }, '你的作文'),
            el('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.8', background: '#fafafa', padding: '.8rem', borderRadius: '4px', fontFamily: 'Georgia, serif' } }, w.essay || '（未作答）')),

          critBars(w.criteria, labels),

          fb.summary_zh && el('p', { style: { marginTop: '.8rem' } }, el('b', {}, '總評：'), fb.summary_zh),
          fb.summary_en && el('p', { class: 'small muted' }, fb.summary_en),

          fb.byCriterion && el('div', {}, Object.entries(fb.byCriterion).map(([k, v]) =>
            el('details', { style: { marginBottom: '.35rem' } },
              el('summary', {}, el('b', {}, labels[k]?.zh || k), ` — ${v.score} 分`),
              el('div', { class: 'small', style: { padding: '.4rem 0 .4rem 1rem' } },
                el('p', {}, v.why_zh || ''),
                v.evidence?.length ? el('ul', {}, v.evidence.map((x) => el('li', { class: 'muted' }, `「${x}」`))) : null,
                v.howToImprove_zh && el('p', {}, el('b', {}, '怎麼改進：'), v.howToImprove_zh))))),

          fb.corrections?.length && el('details', {},
            el('summary', {}, el('b', {}, `逐句修改建議（${fb.corrections.length} 處）`)),
            el('table', { class: 'data', style: { marginTop: '.5rem' } },
              el('thead', {}, el('tr', {}, el('th', {}, '原句'), el('th', {}, '建議改成'), el('th', {}, '問題'))),
              el('tbody', {}, fb.corrections.map((c) => el('tr', {},
                el('td', {}, el('span', { class: 'diff-del' }, c.original)),
                el('td', {}, el('span', { class: 'diff-ins' }, c.corrected)),
                el('td', { class: 'small muted' }, c.issue_zh || ''))))) ),

          fb.upgrades?.length && el('details', {},
            el('summary', {}, el('b', {}, '用字升級建議')),
            el('ul', { style: { lineHeight: '1.8' } }, fb.upgrades.map((u) =>
              el('li', {}, el('code', {}, u.original), ' → ', el('b', {}, u.suggestion),
                u.note_zh ? el('span', { class: 'muted small' }, `（${u.note_zh}）`) : null)))),

          fb.modelAnswer && el('details', {},
            el('summary', {}, el('b', {}, 'Band 8–9 範文')),
            el('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.8', padding: '.6rem 0', fontFamily: 'Georgia, serif' } }, fb.modelAnswer)),

          fb.nextSteps_zh?.length && el('div', { style: { marginTop: '.8rem' } },
            el('b', {}, '接下來可以練習：'),
            el('ol', { style: { lineHeight: '1.8' } }, fb.nextSteps_zh.map((s) => el('li', {}, s)))),

          API.user?.role !== 'student' && teacherOverride(attemptId, 'writing', labels, w.criteria, w.band, w.taskNo));
      }));
  }

  // ── 口說評分 ────────────────────────────────────────────
  function speakingReview(attemptId) {
    const labels = D.criteriaLabels.speaking;
    const mr = D.moduleResults.speaking;
    const fb = mr?.feedback || {};
    const pending = fb.pending;

    return el('div', {},
      el('div', { class: 'card' },
        el('h3', {}, '口說 ', el('span', { style: { color: 'var(--brand)' } }, band(mr?.band)),
          pending ? el('span', { class: 'pill warn', style: { marginLeft: '.6rem' } }, '等待老師評分') : null),
        critBars(mr?.criteria, labels),
        fb.summary_zh && el('p', { style: { marginTop: '.8rem' } }, el('b', {}, '總評：'), fb.summary_zh),
        fb.summary_en && el('p', { class: 'small muted' }, fb.summary_en),
        fb.stats && el('p', { class: 'small muted' },
          `語速 ${fb.stats.wpm} 字/分　·　總時長 ${fb.stats.seconds} 秒　·　總字數 ${fb.stats.words}`),
        API.user?.role !== 'student' && teacherOverride(attemptId, 'speaking', labels, mr?.criteria, mr?.band)),

      fb.byCriterion && el('div', { class: 'card' },
        el('h3', {}, '四大評分標準'),
        Object.entries(fb.byCriterion).map(([k, v]) =>
          el('details', { style: { marginBottom: '.35rem' } },
            el('summary', {}, el('b', {}, labels[k]?.zh || k), ` — ${v.score} 分`),
            el('div', { class: 'small', style: { padding: '.4rem 0 .4rem 1rem' } },
              el('p', {}, v.why_zh || ''),
              v.evidence?.length ? el('ul', {}, v.evidence.map((x) => el('li', { class: 'muted' }, `「${x}」`))) : null,
              v.howToImprove_zh && el('p', {}, el('b', {}, '怎麼改進：'), v.howToImprove_zh))))),

      // AI 是分 Part 診斷的（Part 1 答太短 vs Part 2 沒話講 vs Part 3 講不抽象），
      // 這些資料一直都有回傳，只是畫面沒畫
      fb.byPart && Object.keys(fb.byPart).length ? el('div', { class: 'card' },
        el('h3', {}, '各 Part 表現'),
        Object.entries(fb.byPart).map(([k, v]) => el('div', { style: { marginBottom: '.5rem' } },
          el('b', {}, `Part ${k}`), '　',
          el('span', { class: 'small' }, v?.comment_zh || v?.comment || ''))))
        : null,

      // 寫作有「用字升級建議」，口說的資料格式一模一樣卻沒畫，是漏掉的
      fb.upgrades?.length ? el('div', { class: 'card' },
        el('h3', {}, '用字升級建議'),
        UI.dataTable(
          el('thead', {}, el('tr', {}, el('th', {}, '你用的'), el('th', {}, 'Band 8 說法'), el('th', {}, '為什麼更好'))),
          el('tbody', {}, fb.upgrades.map((u) => el('tr', {},
            el('td', {}, u.original),
            el('td', {}, el('b', {}, u.suggestion)),
            el('td', { class: 'small muted' }, u.note_zh || ''))))))
        : null,

      fb.corrections?.length && el('div', { class: 'card' },
        el('h3', {}, '表達修正'),
        UI.dataTable(
          el('thead', {}, el('tr', {}, el('th', {}, '你說的'), el('th', {}, '更自然的說法'), el('th', {}, '問題'))),
          el('tbody', {}, fb.corrections.map((c) => el('tr', {},
            el('td', {}, el('span', { class: 'diff-del' }, c.original)),
            el('td', {}, el('span', { class: 'diff-ins' }, c.corrected)),
            el('td', { class: 'small muted' }, c.issue_zh || '')))))),

      el('div', { class: 'card' },
        el('h3', {}, '逐題錄音與逐字稿'),
        (D.speaking || []).map((r) => el('div', { style: { borderBottom: '1px solid var(--line-2)', padding: '.7rem 0' } },
          el('div', { class: 'small muted' }, `Part ${r.part} · 第 ${r.q_index + 1} 題 · ${r.duration_sec}s`),
          el('div', { style: { fontWeight: '600', margin: '.2rem 0' } }, r.question || '(cue card)'),
          r.audio_path && el('audio', { controls: true, src: r.audio_path, style: { width: '100%', maxWidth: '420px', margin: '.3rem 0' } }),
          el('div', { class: 'small', style: { lineHeight: '1.7' } }, r.transcript || el('span', { class: 'muted' }, '（沒有辨識到語音）'))))),

      fb.nextSteps_zh?.length && el('div', { class: 'card' },
        el('h3', {}, '練習建議'),
        el('ol', { style: { lineHeight: '1.9' } }, fb.nextSteps_zh.map((s) => el('li', {}, s)))));
  }

  // ── 老師手動改分 ────────────────────────────────────────
  function teacherOverride(attemptId, mod, labels, criteria, current, taskNo) {
    const inputs = {};
    return el('details', { class: 'no-print', style: { marginTop: '1rem', borderTop: '1px dashed var(--line)', paddingTop: '.8rem' } },
      el('summary', { class: 'small muted' }, '老師手動改分'),
      el('div', { style: { paddingTop: '.6rem' } },
        el('div', { class: 'row' }, Object.entries(labels).map(([k, lab]) =>
          el('label', { class: 'field' },
            el('span', {}, `${lab.zh} ${k}`),
            (inputs[k] = el('input', { type: 'number', min: 0, max: 9, step: 0.5, value: criteria?.[k] ?? '' }))))),
        el('label', { class: 'field' }, el('span', {}, '評語'),
          (inputs._c = el('textarea', { rows: 2 }))),
        el('button', {
          class: 'btn primary sm',
          onclick: async () => {
            const crit = {};
            for (const k of Object.keys(labels)) {
              const v = Number(inputs[k].value);
              if (!Number.isNaN(v) && inputs[k].value !== '') crit[k] = v;
            }
            try {
              await API.post(`/results/${attemptId}/grade`, {
                module: mod, criteria: crit, comment: inputs._c.value, taskNo,
              });
              UI.toast('已更新成績', 'ok');
              location.reload();
            } catch (e) { UI.alert(e.message); }
          },
        }, '儲存分數')));
  }

  return { render };
})();
