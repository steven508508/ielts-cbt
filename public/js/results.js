/* ═══════════════════════════════════════════════════════════
   成績單（仿官方 TRF）與逐題檢討報告
   ═══════════════════════════════════════════════════════════ */
const Results = (() => {
  const { el, sanitize, band, fmtDate } = UI;
  let D = null;
  let pollTimer = null;

  async function render(attemptId, mount) {
    clearInterval(pollTimer);
    UI.render(mount, el('div', { class: 'empty' }, '載入成績中…'));
    try {
      D = await API.get(`/results/${attemptId}`);
    } catch (e) { return UI.render(mount, el('div', { class: 'empty' }, e.message)); }

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
    return el('div');
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

    const bySection = new Map();
    for (const q of rows) {
      if (!bySection.has(q.section)) bySection.set(q.section, []);
      bySection.get(q.section).push(q);
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

      [...bySection].map(([sec, qs]) => el('div', { class: 'card' },
        el('h3', {}, sec),
        qs.map((q) => el('div', { class: `rev-q ${q.correct ? 'correct' : 'wrong'}` },
          el('div', { class: 'hd' },
            el('b', {}, `Q${q.number}`),
            el('span', { class: `pill ${q.correct ? 'ok' : 'err'}` }, q.correct ? '答對' : '答錯'),
            el('span', { class: 'muted small' }, TYPE_LABEL[q.type] || q.type)),
          q.text && el('div', { class: 'small', style: { marginBottom: '.3rem' }, html: sanitize(q.text) }),
          el('div', { class: 'small' },
            '你的答案：', el('span', { class: 'yours' }, q.response || '（未作答）'),
            !q.correct ? el('span', {}, '　正解：', el('b', {}, (q.answers || []).join(' / '))) : null),
          q.explanation && el('div', { class: 'exp', html: sanitize(q.explanation) }))))));
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

          w.prompt && el('details', { style: { marginBottom: '.8rem' } },
            el('summary', { class: 'small muted' }, '題目'),
            el('div', { class: 'bodyhtml small', html: sanitize(w.prompt) })),

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

      fb.corrections?.length && el('div', { class: 'card' },
        el('h3', {}, '表達修正'),
        el('table', { class: 'data' },
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
