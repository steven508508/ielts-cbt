/* 示範站的假後端。
 *
 * GitHub Pages 只能放靜態檔案，跑不了 Node 與 MySQL。但整個前端跟後端溝通
 * 都收斂在 api.js 裡的一個 fetch()，所以只要在 api.js 之前把 window.fetch
 * 換掉，前端一行都不用改，跑的就是真正的 UI 程式碼。
 *
 * 這裡刻意「不」重寫批改邏輯 —— server/lib/answers.js 與 server/lib/bands.js
 * 是原封不動搬過來的（見 lib.js），所以示範站算出來的分數跟真的伺服器一樣。
 *
 * 狀態只存在記憶體裡：重整就是全新的一份，不需要每日重置。
 */
(function () {
  'use strict';

  const D = window.DEMO_DATA;
  const { checkAnswer, countWords } = window.DEMO_LIB.answers;
  const { rawToBand, overallBand, criteriaToBand } = window.DEMO_LIB.bands;

  // ── 假的登入狀態 ────────────────────────────────────────────────────
  // api.js 在 IIFE 裡就讀 localStorage，所以要搶在它之前寫進去。
  const USER = D.user;
  const TOKEN = 'demo.' + btoa(JSON.stringify({ uid: USER.id, role: USER.role }));
  try {
    localStorage.setItem('ielts_token', TOKEN);
    localStorage.setItem('ielts_user', JSON.stringify(USER));
    // 考前環境檢查在真站是進考場前的一道門（七天有效）。示範站不該讓訪客
    // 一按「開始考試」就撞上麥克風權限請求 —— 何況這裡的口說是錄好的、
    // 根本不用麥克風。所以預先寫進通過紀錄，功能本身仍留在頁首的
    //「🩺 環境檢查」，想看的人點得到。
    // recentlyPassed() 看的是 micOk 這個欄位（見 public/js/check.js）
    localStorage.setItem('ielts_devicecheck', JSON.stringify({
      version: 1, at: Date.now(), micOk: true, demo: true,
    }));
  } catch { /* 無痕模式也要能跑 */ }

  // ── 記憶體狀態 ──────────────────────────────────────────────────────
  const S = {
    attemptId: 9001,
    started: false,
    submitted: false,
    graded: false,
    answers: new Map(),      // number → value
    writing: new Map(),      // taskNo → text
    modules: {},             // module → {startedAt, endsAt, finished}
    events: [],
  };

  const now = () => Date.now();
  const durationOf = (m) => D.exam.rules.durations[m] || 1800;

  // 每一題（含所屬題組資訊）攤平，批改與檢討都靠它
  const FLAT = (() => {
    const out = { listening: [], reading: [], writing: [], speaking: [] };
    for (const mod of D.paperFull.modules) {
      const bucket = out[mod.module];
      if (!bucket) continue;
      mod.sections.forEach((sec, si) => {
        (sec.groups || []).forEach((g, gi) => {
          (g.questions || []).forEach((q) => {
            bucket.push({
              ...q,
              type: g.type,
              instructions: g.instructions || '',
              options: g.options || null,
              optionsShared: !!g.options,
              bodyHtml: g.bodyHtml || null,
              image: g.image || null,
              wordLimit: g.wordLimit,
              allowNumbers: g.allowNumbers,
              section: sec.title || `Section ${si + 1}`,
              sectionIndex: si,
              groupIndex: gi,
              text: q.text || '',
            });
          });
        });
      });
    }
    return out;
  })();

  // ── 路由 ────────────────────────────────────────────────────────────
  const routes = [];
  const on = (method, pattern, handler) => routes.push({ method, pattern, handler });
  const J = (body, status = 200) => ({ status, body });

  on('GET', /^\/health$/, () => J({ ok: true, demo: true, version: 'demo' }));
  on('GET', /^\/auth\/config$/, () => J({ turnstile: { enabled: false, siteKey: '' } }));
  on('GET', /^\/check\/config$/, () => J(D.checkConfig));
  on('POST', /^\/auth\/login$/, () => J({ token: TOKEN, user: USER }));
  on('POST', /^\/auth\/password$/, () => J({ error: '示範站不提供改密碼' }, 400));

  on('GET', /^\/notifications\/count$/, () => J({ unread: 0 }));
  on('GET', /^\/notifications/, () => J({ items: [], total: 0 }));
  on('POST', /^\/notifications\/read$/, () => J({ ok: true }));

  on('GET', /^\/exam\/available$/, () => J({
    available: [{ ...D.available, attempts: S.started ? [attemptRow()] : [] }],
  }));
  on('GET', /^\/exam\/my-attempts$/, () => J({ attempts: S.started ? [attemptRow()] : [] }));

  on('POST', /^\/exam\/start$/, () => {
    const resumed = S.started;
    S.started = true;
    return J({ attemptId: S.attemptId, resumed });
  });

  on('GET', /^\/exam\/\d+$/, () => {
    S.started = true;
    return J({
      ...D.exam,
      attempt: { ...D.exam.attempt, id: S.attemptId, status: S.submitted ? 'submitted' : 'in_progress' },
      state: { modules: moduleState() },
      saved: {
        answers: [...S.answers].map(([number, value]) => ({ number, value })),
        writing: [...S.writing].map(([taskNo, text]) => ({ taskNo, text, wordCount: countWords(text) })),
        speaking: [],
      },
      serverTime: now(),
    });
  });

  on('POST', /^\/exam\/\d+\/module\/start$/, (req) => {
    const m = req.body?.module;
    if (!m) return J({ error: '缺少 module' }, 400);
    const resumed = !!S.modules[m];
    if (!resumed) {
      const sec = durationOf(m);
      S.modules[m] = { startedAt: now(), endsAt: now() + sec * 1000, finished: false };
    }
    const st = S.modules[m];
    return J({
      startedAt: st.startedAt, endsAt: st.endsAt, serverTime: now(), resumed,
      durationSec: durationOf(m),
      breakdown: D.exam.rules.breakdown[m] || { paperSec: durationOf(m), overrideSec: null, extraSec: 0, totalSec: durationOf(m) },
    });
  });

  on('POST', /^\/exam\/\d+\/module\/finish$/, (req) => {
    const m = req.body?.module;
    if (S.modules[m]) S.modules[m].finished = true;
    return J({ ok: true });
  });

  on('GET', /^\/exam\/\d+\/time$/, () => J({
    serverTime: now(),
    status: S.submitted ? 'submitted' : 'in_progress',
    modules: moduleState(true),
  }));

  on('GET', /^\/exam\/\d+\/status$/, () => {
    const g = S.graded ? grade() : null;
    return J({
      status: S.graded ? 'graded' : S.submitted ? 'grading' : 'in_progress',
      listening_band: g?.bands.listening ?? null,
      reading_band: g?.bands.reading ?? null,
      writing_band: g?.bands.writing ?? null,
      speaking_band: g?.bands.speaking ?? null,
      overall_band: g?.overall ?? null,
      modules: [],
    });
  });

  on('POST', /^\/exam\/\d+\/answers$/, (req) => {
    const list = req.body?.answers || [];
    for (const a of list) {
      if (a.value === '' || a.value == null) S.answers.delete(Number(a.number));
      else S.answers.set(Number(a.number), a.value);
    }
    return J({ ok: true, saved: list.length, rejected: [] });
  });

  on('POST', /^\/exam\/\d+\/writing$/, (req) => {
    const t = req.body || {};
    const taskNo = Number(t.task ?? t.taskNo ?? 1);
    S.writing.set(taskNo, String(t.text || ''));
    return J({ ok: true, wordCount: countWords(String(t.text || '')) });
  });

  on('POST', /^\/exam\/\d+\/event$/, (req) => {
    S.events.push({ ...req.body, at: now() });
    return J({ ok: true });
  });

  on('POST', /^\/exam\/\d+\/submit$/, () => {
    S.submitted = true;
    // 真的伺服器是排進批改佇列後非同步完成；這裡用一個短延遲重現那個過程
    setTimeout(() => { S.graded = true; }, 1200);
    return J({ ok: true, attemptId: S.attemptId, grading: true });
  });

  on('GET', /^\/results\/\d+$/, () => J(buildResult()));
  on('POST', /^\/results\/\d+\/regrade$/, () => J({ error: '示範站不重新批改' }, 400));
  on('POST', /^\/results\/\d+\/grade$/, () => J({ error: '示範站不提供人工批改' }, 400));

  // 練習模式在示範站沒有題庫，老實回空的，前端會顯示「沒有題目」
  on('GET', /^\/practice\/wrong/, () => J({ items: [] }));
  on('POST', /^\/practice\/drill$/, () => J({ error: '示範站沒有開練習模式' }, 400));
  on('POST', /^\/practice\/drill\/check$/, () => J({ error: '示範站沒有開練習模式' }, 400));
  on('POST', /^\/practice\/speaking\/question$/, () => J({ error: '示範站沒有開練習模式' }, 400));
  on('POST', /^\/practice\/speaking\/grade$/, () => J({ error: '示範站沒有開練習模式' }, 400));

  // AI 批改：示範站用預先算好的評語，不打任何外部 API
  on('POST', /^\/ai\/grade-writing$/, () => J(D.writingFeedback));

  // speaking.js 看的是 st.ok，不是 enabled。回錯欄位的話會靜靜地退回
  // 「語音問答」模式 —— 畫面看起來正常，但示範站最想展示的即時對話就沒了。
  on('GET', /^\/speaking\/realtime\/status$/, () => J({
    ok: true, model: 'demo-scripted-examiner', version: 'demo',
    examiner: { showCueCard: true, showLiveScore: true, showTranscript: true },
  }));
  on('POST', /^\/speaking\/\d+\/recording$/, () => J({ ok: true, skipped: '示範站不上傳錄音' }));
  on('POST', /^\/speaking\/\d+\/finalize$/, () => J({ ok: true }));
  on('POST', /^\/speaking\/\d+\/score-now$/, () => J({ ok: true }));
  on('POST', /^\/speaking\/tts$/, () => J({ error: '示範站不合成語音' }, 400));

  // ── 輔助 ────────────────────────────────────────────────────────────
  function attemptRow() {
    return {
      id: S.attemptId, test_id: 1, assignment_id: 1,
      status: S.graded ? 'graded' : S.submitted ? 'grading' : 'in_progress',
      started_at: fmt(now()), submitted_at: S.submitted ? fmt(now()) : null,
      modules: 'listening,reading,writing,speaking',
    };
  }
  function fmt(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function moduleState(withRemaining) {
    const out = {};
    for (const m of D.exam.attempt.modules) {
      const st = S.modules[m];
      if (!st) { out[m] = { started: false }; continue; }
      const remainingSec = Math.max(0, Math.round((st.endsAt - now()) / 1000));
      out[m] = {
        started: true, finished: !!st.finished,
        expired: remainingSec <= 0, endsAt: st.endsAt,
        ...(withRemaining ? { remainingSec } : {}),
      };
    }
    return out;
  }

  // 用真的 checkAnswer / rawToBand 批改
  function grade() {
    const res = { detail: {}, raw: {}, bands: {}, overall: null };
    for (const m of ['listening', 'reading']) {
      const qs = FLAT[m];
      let raw = 0;
      const detail = qs.map((q) => {
        const response = S.answers.get(q.number) ?? '';
        // checkAnswer 回的是 {correct, awarded, max} 物件，不是布林值。
        // 以前這裡寫成 !!checkAnswer(...) —— 物件永遠 truthy，所以不管答什麼
        // 都算對，示範站每個人都會拿到 band 9。用 awarded 才對，多選題也才
        // 拿得到部分分數。
        const r = checkAnswer(q, response, { allowNumbers: q.allowNumbers });
        raw += r.awarded || 0;
        return { q, response, correct: !!r.correct, awarded: r.awarded || 0, reason: r.reason || null };
      });
      res.detail[m] = detail;
      res.raw[m] = raw;
      res.bands[m] = rawToBand(raw, qs.length, m, D.exam.paper.testType || 'academic');
    }
    // 寫作／口說：示範站用預先寫好的評分（真站是 AI 批改）
    res.bands.writing = S.writing.size ? criteriaToBand(D.writingFeedback.criteria) : null;
    res.bands.speaking = D.speaking.scored ? criteriaToBand(D.speaking.criteria) : null;
    const list = ['listening', 'reading', 'writing', 'speaking']
      .map((k) => res.bands[k]).filter((x) => typeof x === 'number');
    res.overall = list.length ? overallBand(res.bands) : null;
    return res;
  }

  function buildResult() {
    const g = grade();
    const review = {};
    const reviewMedia = {};

    for (const m of ['listening', 'reading']) {
      review[m] = g.detail[m].map(({ q, response, correct }) => ({
        number: q.number, type: q.type, section: q.section, text: q.text,
        sectionIndex: q.sectionIndex, response, correct,
        answers: q.answers || [], explanation: q.explanation || null,
        options: q.options, optionsShared: q.optionsShared,
        groupIndex: q.groupIndex, instructions: q.instructions,
        image: q.image, bodyHtml: q.bodyHtml,
      }));
      const mod = D.paperFull.modules.find((x) => x.module === m);
      reviewMedia[m] = mod.sections.map((sec, i) => ({
        index: i, title: sec.title || `Section ${i + 1}`,
        passageTitle: sec.passageTitle || null,
        passage: sec.passage || null,
        transcript: sec.transcript || null,
        audio: sec.audio || null,
        image: sec.image || null,
      }));
    }

    const writing = [...S.writing.entries()].map(([taskNo, essay]) => ({
      taskNo, essay, wordCount: countWords(essay),
      band: criteriaToBand(D.writingFeedback.criteria),
      criteria: D.writingFeedback.criteria,
      feedback: D.writingFeedback.feedback,
      gradedBy: 'ai', gradedAt: fmt(now()),
    }));

    return {
      ...D.resultShell,
      attempt: {
        ...D.resultShell.attempt, id: S.attemptId,
        status: S.graded ? 'graded' : 'grading',
        listening_band: g.bands.listening, reading_band: g.bands.reading,
        writing_band: writing.length ? g.bands.writing : null,
        speaking_band: g.bands.speaking, overall_band: g.overall,
      },
      moduleResults: {
        listening: { raw: g.raw.listening, total: FLAT.listening.length, band: g.bands.listening },
        reading: { raw: g.raw.reading, total: FLAT.reading.length, band: g.bands.reading },
      },
      review, reviewMedia, writing,
      speaking: D.speaking.scored ? [D.speaking.result] : [],
    };
  }

  // ── 攔截 fetch ──────────────────────────────────────────────────────
  const realFetch = window.fetch.bind(window);

  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    const m = url.match(/^(?:https?:\/\/[^/]+)?\/api(\/.*)$/);
    if (!m) return realFetch(input, init);

    const path = m[1];
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    let body = null;
    if (init.body && typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = null; } }

    // 真的伺服器有延遲。完全瞬間回應會讓「儲存中…」之類的狀態一閃而過，
    // 訪客反而看不到這個系統其實有在處理儲存失敗。
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 90));

    for (const r of routes) {
      if (r.method !== method) continue;
      const mm = path.split('?')[0].match(r.pattern);
      if (!mm) continue;
      let out;
      try {
        out = r.handler({ path, method, body, params: mm });
      } catch (e) {
        console.error('[demo] 假後端出錯', path, e);
        out = J({ error: '示範站內部錯誤：' + e.message }, 500);
      }
      return new Response(JSON.stringify(out.body), {
        status: out.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    console.warn('[demo] 沒接住的請求', method, path);
    return new Response(JSON.stringify({ error: `示範站沒有實作這個功能（${method} ${path}）` }),
      { status: 501, headers: { 'content-type': 'application/json' } });
  };

  window.DEMO = { state: S, grade, flat: FLAT };
})();
