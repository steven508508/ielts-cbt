/* ═══════════════════════════════════════════════════════════
   口說模組
   · 即時模式：與 AI 考官真正的即時語音對話（可插話、邊說邊出逐字稿）
   · 輪替模式：沒有 Realtime 端點時的備援，考官念題 → 錄音 → 辨識
   兩種模式都跑官方 Part 1 / 2 / 3 流程，並在過程中累進更新分數
   ═══════════════════════════════════════════════════════════ */
const Speaking = (() => {
  const { el, toast, fmtTime } = UI;
  const $ = (s, r = document) => r.querySelector(s);
  const root = () => document.getElementById('app');

  let S = null;

  // ══ 共用外殼 ══════════════════════════════════════════════
  function shell(...body) {
    const c = el('div', { class: 'cbt' },
      el('div', { class: 'cbt-top' },
        el('div', { class: 'cbt-cand' },
          el('b', {}, API.user?.name || '考生'),
          el('span', {}, '— IELTS Speaking')),
        el('div', { class: 'grow' }),
        el('span', { class: 'small', id: 'sp-mode' }, S?.realtime ? '即時語音對話' : '語音問答'),
        el('button', { class: 'cbt-tool', onclick: () => Exam.notice('說明', helpText()) }, '❓ Help'),
        el('button', { class: 'cbt-tool', onclick: quit }, '離開')),
      el('div', { class: 'cbt-center' }, el('div', { class: 'cbt-speak' }, ...body)));
    root().replaceChildren(c);
    c.dataset.size = Exam.prefs.size;
    c.dataset.scheme = Exam.prefs.scheme;
    return c;
  }

  const helpText = () => el('div', {},
    el('p', {}, '考官會用語音提問。', S?.realtime
      ? '這是即時對話模式：你隨時可以開口，不需要按任何按鈕，說完停頓一下考官就會接話。'
      : '這是問答模式：考官問完後按麥克風開始回答，說完再按一次結束。'),
    el('p', {}, 'Part 2 會先給你 1 分鐘準備，然後說 1–2 分鐘。'),
    el('p', {}, '建議戴耳機，避免考官的聲音被錄進去。'));

  async function quit() {
    const ok = await Exam.dlg({
      title: '離開口說測驗',
      body: el('p', {}, '確定要離開嗎？已完成的部分會保留，但整場口說不會有完整成績。'),
      actions: [{ label: '繼續作答', value: false }, { label: '離開', primary: true, value: true }],
    });
    if (!ok) return;
    teardown();
    S.onDone?.();
  }

  // ══ 進入 ══════════════════════════════════════════════════
  async function run({ attemptId, paper, mode = 'ai', saved = [], onDone }) {
    S = {
      attemptId, paper, mode, onDone,
      realtime: false, ws: null, ctx: null, worklet: null, stream: null,
      sources: [], playHead: 0, chat: [], live: null,
      phase: 'idle', steps: buildSteps(paper), i: 0,
      qIndexByPart: { 1: 0, 2: 0, 3: 0 },
      recorder: null, recChunks: [],
    };
    try {
      const st = await API.get('/speaking/realtime/status');
      S.realtime = !!st.ok;
      S.realtimeModel = st.model;
    } catch { S.realtime = false; }
    renderIntro();
  }

  function renderIntro() {
    shell(
      el('h2', {}, 'Speaking Test'),
      el('p', { style: { lineHeight: '1.8' } },
        '整場約 11–14 分鐘，分三個部分。',
        S.realtime
          ? '考官會即時和你對話，你隨時可以開口，也可以打斷考官。'
          : '考官會念出題目，你按麥克風回答。'),
      el('div', { class: 'cbt-card', style: { textAlign: 'left', margin: '1rem auto', maxWidth: '560px' } },
        el('div', { class: 'info' },
          el('div', {}, el('span', {}, 'Part 1'), el('span', {}, '自我介紹與熟悉話題（4–5 分鐘）')),
          el('div', {}, el('span', {}, 'Part 2'), el('span', {}, '題卡：1 分鐘準備，說 1–2 分鐘')),
          el('div', {}, el('span', {}, 'Part 3'), el('span', {}, '延伸討論（4–5 分鐘）')),
          el('div', {}, el('span', {}, '模式'), el('span', {},
            S.realtime ? `即時語音對話（${S.realtimeModel || 'realtime'}）` : '語音問答（未設定即時端點）')),
          el('div', {}, el('span', {}, '評分'), el('span', {},
            S.mode === 'ai' ? 'AI 即時評分，考完立刻出分' : '錄音存檔，由老師評分')))),
      el('div', { id: 'mic-state', class: 'small', style: { opacity: '.75' } }, '尚未測試麥克風'),
      el('div', { class: 'cbt-actions', style: { justifyContent: 'center' } },
        el('button', { class: 'cbt-btn', onclick: testMic }, '測試麥克風'),
        el('button', { class: 'cbt-btn primary', onclick: begin }, '開始口說測驗')));
  }

  async function testMic() {
    const box = $('#mic-state');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      box.textContent = '✓ 麥克風正常';
      box.style.color = 'var(--c-ok, #1e7d3c)';
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      const h = micHelp(e);
      box.textContent = `✗ ${h.title} —— ${h.lines[0]}`;
      box.style.color = 'var(--c-danger, #c0392b)';
    }
  }

  /**
   * 麥克風出問題時給看得懂的說明，而不是把瀏覽器的英文錯誤丟給學生。
   * 順便回報一筆 device_permission —— 伺服器看到這筆之後，接下來三分鐘
   * 學生離開畫面（去瀏覽器設定開權限）會記成「處理裝置權限」而不是違規。
   */
  function micHelp(err) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return {
        title: '瀏覽器擋住了麥克風',
        lines: [
          '請點網址列最左邊的圖示（鎖頭或滑桿），把「麥克風」改成「允許」，再按下面的「再試一次」。',
          '如果找不到那個選項，到瀏覽器設定搜尋「麥克風」，把這個網站加進允許清單。',
        ],
        note: '接下來幾分鐘為了處理權限而離開考試畫面，不會被算成違規。',
      };
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return { title: '找不到麥克風', lines: ['請把耳機或麥克風插好，再按「再試一次」。'], note: '' };
    }
    if (name === 'NotReadableError') {
      return {
        title: '麥克風被其他程式占用',
        lines: ['請關掉視訊會議、錄音或其他正在用麥克風的程式，再按「再試一次」。'],
        note: '',
      };
    }
    if (!window.isSecureContext) {
      return {
        title: '這個網址拿不到麥克風',
        lines: ['瀏覽器只在 https:// 或 localhost 才給麥克風權限。請通知監考老師。'],
        note: '',
      };
    }
    if (name === 'NotSupportedError') {
      return {
        title: '這台電腦不允許錄音',
        lines: ['系統或瀏覽器政策擋住了錄音（常見於學校統一管理的電腦）。請通知監考老師。'],
        note: '',
      };
    }
    return {
      title: '無法取得麥克風',
      lines: ['建議改用 Chrome 或 Edge 再試一次。',
        `還是不行的話，把這段訊息給老師：${name || 'Error'} / ${err?.message || ''}`],
      note: '',
    };
  }

  async function getMic() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  }

  async function begin() {
    if (!S.steps.length && !S.realtime) {
      await Exam.notice('沒有口說題目', el('p', {}, '這份試卷沒有口說內容。'));
      return S.onDone?.();
    }

    // 全螢幕底下瀏覽器的權限提示很容易被忽略，先退出來再問
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { /* 不支援就算了 */ }
    }

    for (;;) {
      try {
        S.stream = await getMic();
        break;
      } catch (e) {
        const h = micHelp(e);
        // 讓伺服器知道這是裝置問題，接下來的離開才不會被當成作弊
        API.post(`/exam/${S.attemptId}/event`, {
          type: 'device_permission', module: 'speaking', detail: `${h.title}（${e.name || 'Error'}）`,
        }).catch(() => {});

        const again = await Exam.dlg({
          title: h.title,
          body: el('div', {},
            h.lines.map((t) => el('p', {}, t)),
            h.note ? el('p', { class: 'small', style: { opacity: '.8' } }, h.note) : null),
          actions: [
            { label: '先跳過口說', value: false },
            { label: '再試一次', primary: true, value: true },
          ],
        });
        if (!again) return S.onDone?.();
      }
    }

    startBackupRecording();
    if (S.realtime) return startRealtime();
    return startTurnMode();
  }

  /** 整場備份錄音，供老師事後聆聽 */
  function startBackupRecording() {
    try {
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find((m) => MediaRecorder.isTypeSupported(m));
      S.recorder = new MediaRecorder(S.stream, mime ? { mimeType: mime } : undefined);
      S.recChunks = [];
      S.recorder.ondataavailable = (e) => { if (e.data.size) S.recChunks.push(e.data); };
      S.recorder.start(4000);
    } catch { S.recorder = null; }
  }

  async function uploadBackupRecording() {
    if (!S.recorder) return;
    try {
      await new Promise((r) => { S.recorder.onstop = r; S.recorder.stop(); });
      const blob = new Blob(S.recChunks, { type: S.recorder.mimeType || 'audio/webm' });
      if (!blob.size) return;
      const fd = new FormData();
      fd.append('audio', blob, 'full-interview.webm');
      await API.post(`/speaking/${S.attemptId}/recording`, fd);
    } catch { /* 錄音備份失敗不影響成績 */ }
  }

  // ══ 即時模式 ══════════════════════════════════════════════
  const WORKLET = `
class Cap extends AudioWorkletProcessor {
  process(inputs){ const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor('cap', Cap);`;

  const RATE = 24000;

  function f32ToPcm16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  /**
   * 降到 24kHz。
   *
   * `new AudioContext({sampleRate: 24000})` 不是每個瀏覽器都會照做（Safari
   * 尤其常見），拿到的其實是硬體的 48kHz。舊版沒有檢查就直接當成 24kHz 送上去，
   * 考官聽到的是慢一半的聲音 —— 辨識不出文字、答非所問，全部由此而來。
   */
  function resampleTo24k(f32, from) {
    if (from === RATE) return f32;
    const ratio = from / RATE;
    const out = new Float32Array(Math.floor(f32.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const frac = pos - j;
      out[i] = f32[j] * (1 - frac) + (f32[j + 1] ?? f32[j]) * frac;
    }
    return out;
  }

  function b64ToInt16(b64) {
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return new Int16Array(buf);
  }

  async function startRealtime() {
    renderLive();
    setStage('連線中…');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/speaking?token=${encodeURIComponent(API.token)}&attemptId=${S.attemptId}`;

    /* 自動重連。以前 onclose 只把畫面文字改成「連線中斷」就結束了 ——
       網路抖一下、Wi-Fi 換基地台、筆電闔上再打開，這一科就等於報銷，
       學生只能重新整理，而重新整理會讓考官從頭再問一次名字。
       伺服器那邊會接回原本的階段與逐字稿，所以重連是安全的。 */
    let tries = 0;
    const open = () => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      S.ws = ws;
      ws.onopen = () => {
        tries = 0;
        setStage(S.resumed ? '已重新連上，請繼續' : '連線成功，等待考官…');
      };
      ws.onmessage = (ev) => onServer(JSON.parse(ev.data));
      ws.onerror = () => {};
      ws.onclose = () => {
        if (S.finished || S.fatal) return;
        tries += 1;
        if (tries > 5) {
          setStage('連線中斷');
          return toast('連線一直接不回來。錄音有存下來，請舉手告訴監考老師。', 'err');
        }
        const wait = Math.min(8000, 700 * 2 ** (tries - 1));
        setStage(`連線中斷，${Math.round(wait / 1000)} 秒後重試（第 ${tries} 次）`);
        setTimeout(() => { if (!S.finished && !S.fatal) open(); }, wait);
      };
    };
    open();

    // 音訊：24kHz 單聲道
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
    S.ctx = ctx;
    // 瀏覽器不一定給得到指定的取樣率，拿實際值來換算
    S.inRate = ctx.sampleRate;
    if (S.inRate !== RATE) console.warn(`[speaking] 瀏覽器給的是 ${S.inRate}Hz，送出前會降到 ${RATE}Hz`);
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
    const src = ctx.createMediaStreamSource(S.stream);
    const node = new AudioWorkletNode(ctx, 'cap');
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    src.connect(node);
    /* 這一行以前是 `node.connect(ctx.createGain())` —— 一個沒有接到
       ctx.destination 的 GainNode。Web Audio 是從 destination 反向拉的，
       接到一個懸空的節點等於整條線根本不會被拉，AudioWorkletProcessor 的
       process() 一次都不會被呼叫。實測：懸空 1.5 秒收到 0 個音框，
       接到 destination 收到 285 個。
       也就是說學生的聲音從來沒有送出去過 —— 考官全程在自言自語。
       要靜音就把增益設成 0，不能不接。 */
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);
    S.worklet = node;
    S.mute = mute;

    /* Worklet 每 128 個取樣點回呼一次 —— 24kHz 之下是 5.3 毫秒，
       等於每秒 188 個 WebSocket 封包，每個才 256 位元組。這種碎片化
       在經過 Cloudflare 之後延遲與抖動都很明顯，講起來就是「卡卡的」。
       先攢到 60 毫秒再送，封包數少 11 倍。 */
    const CHUNK = Math.round(RATE * 0.06);
    let pending = [];
    let pendingLen = 0;
    node.port.onmessage = (e) => {
      if (S.ws?.readyState !== WebSocket.OPEN) return;
      const chunk = resampleTo24k(e.data, S.inRate);
      pending.push(chunk);
      pendingLen += chunk.length;
      if (pendingLen < CHUNK) return;
      const merged = new Float32Array(pendingLen);
      let at = 0;
      for (const c of pending) { merged.set(c, at); at += c.length; }
      pending = []; pendingLen = 0;
      S.ws.send(f32ToPcm16(merged).buffer);
    };

    const buf = new Uint8Array(analyser.frequencyBinCount);
    const meter = () => {
      if (S.finished) return;
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      const bar = $('#sp-level');
      if (bar) bar.style.width = `${Math.min(100, (peak / 55) * 100)}%`;
      requestAnimationFrame(meter);
    };
    meter();
  }

  function playChunk(int16) {
    const ctx = S.ctx;
    if (!ctx) return;
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x8000;
    const buffer = ctx.createBuffer(1, f32.length, 24000);
    buffer.copyToChannel(f32, 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const now = ctx.currentTime;
    if (S.playHead < now) S.playHead = now + 0.04;
    node.start(S.playHead);
    S.playHead += buffer.duration;
    S.sources.push(node);
    node.onended = () => { S.sources = S.sources.filter((s) => s !== node); };
  }

  function stopPlayback() {
    for (const s of S.sources) { try { s.stop(); } catch {} }
    S.sources = [];
    S.playHead = 0;
  }

  function onServer(msg) {
    switch (msg.type) {
      case 'ready': setStage('考官準備好了'); break;
      case 'audio': playChunk(b64ToInt16(msg.delta)); setOrb('examiner'); break;
      case 'examiner_partial': setQline(msg.text); break;
      case 'examiner':
        addChat('ex', msg.text);
        setQline(msg.text);
        break;
      case 'examiner_done': setOrb(''); break;
      case 'candidate_speaking':
        setOrb(msg.on ? 'candidate' : '');
        /* 只有伺服器說「這次算打斷」才停掉考官的聲音。
           以前是一偵測到聲音就無條件停播並送 cancel_response ——
           沒戴耳機時考官自己的聲音會被麥克風收回去，考官因此把自己
           講到一半的話砍掉；而且多半根本沒有進行中的回應，
           端點會回一句錯誤，變成學生畫面上莫名其妙的紅字。 */
        if (msg.on && msg.bargeIn) stopPlayback();
        break;
      case 'candidate': addChat('ca', msg.text); break;
      case 'phase': onPhase(msg); break;
      case 'prep': runPrep(msg.seconds, msg.cueCard); break;
      case 'talk': runTalk(msg.seconds); break;
      case 'live_score': showLive(msg); break;
      case 'finishing': setStage('測驗結束，正在評分…'); break;
      case 'final_score': S.finalScore = msg; break;
      case 'done': finishRealtime(); break;
      case 'nudged': setStage('已請考官接話'); break;
      case 'stt_failed': toast(msg.message, 'err'); break;
      case 'stalled':
        setStage('考官沒有接話');
        toast(msg.message, 'warn');
        break;
      /* 上游（考官那一端）掉線。以前伺服器有送這則訊息，但這裡沒有任何
         case 接它 —— 學生的畫面完全不會變，就只是考官從此不再講話。 */
      case 'upstream_closed':
        stopPlayback();
        setStage(msg.fatal ? '與考官失去連線' : '正在重新接上考官…');
        toast(msg.message || '與考官的連線中斷', msg.fatal ? 'err' : 'warn');
        break;
      case 'upstream_reopened':
        setStage('考官回來了');
        toast(msg.message || '考官回來了，請繼續。', 'ok');
        break;
      /* 接續先前的考試（重新整理或斷線之後）：把已經講過的補回畫面上 */
      case 'resumed':
        S.resumed = true;
        for (const t of msg.turns || []) addChat(t.role === 'examiner' ? 'ex' : 'ca', t.text);
        toast('已接回先前的進度，請從剛才的地方繼續。', 'ok');
        break;
      case 'error': toast(msg.message, 'err'); break;
      case 'fatal':
        S.fatal = true;
        Exam.notice('無法開始即時對話', el('div', {},
          el('p', {}, msg.message),
          el('p', { class: 'small' }, '將改用語音問答模式。')))
          .then(() => { S.realtime = false; startTurnMode(); });
        break;
      default: break;
    }
  }

  function onPhase(msg) {
    S.phase = msg.phase;
    const names = {
      intro: '介紹', part1: 'PART 1', part2_instruct: 'PART 2', part2_prep: 'PART 2 · 準備時間',
      part2_talk: 'PART 2 · 長回答', part2_round: 'PART 2 · 收尾', part3: 'PART 3', end: '結束',
    };
    setStage(names[msg.phase] || msg.phase);
    const cue = $('#sp-cue');
    if (cue) cue.style.display = msg.cueCard ? '' : 'none';
    if (msg.cueCard) fillCue(msg.cueCard);
  }

  function runPrep(seconds, cueCard) {
    if (cueCard) fillCue(cueCard);
    let left = seconds;
    setStage('PART 2 · 準備時間');
    setQline('你有 1 分鐘準備，可以在紙上作筆記。');
    clearInterval(S.timer);
    S.timer = setInterval(() => {
      left -= 1;
      setTimerText(left, seconds);
      if (left <= 0) clearInterval(S.timer);
    }, 1000);
    setTimerText(left, seconds);
  }

  function runTalk(seconds) {
    let left = seconds;
    setStage('PART 2 · 請開始回答');
    clearInterval(S.timer);
    S.timer = setInterval(() => {
      left -= 1;
      setTimerText(left, seconds);
      if (left <= 0) clearInterval(S.timer);
    }, 1000);
    setTimerText(left, seconds);
  }

  async function finishRealtime() {
    S.finished = true;
    clearInterval(S.timer);
    await uploadBackupRecording();
    renderFinish(S.finalScore);
  }

  // ══ 即時模式畫面 ══════════════════════════════════════════
  function renderLive() {
    shell(
      el('div', { class: 'stage', id: 'sp-stage' }, '準備中'),
      el('div', { class: 'qline', id: 'sp-q' }, ''),
      el('div', { class: 'cbt-cue', id: 'sp-cue', style: { display: 'none' } }),
      el('div', { class: 'cbt-bigtimer', id: 'sp-timer', style: { display: 'none' } }, '00:00'),
      el('div', { class: 'cbt-orb', id: 'sp-orb' }, el('span', { class: 'ring' }), '🎙'),
      el('div', { class: 'cbt-level' }, el('i', { id: 'sp-level' })),
      el('p', { class: 'small', style: { opacity: '.7', marginTop: '.7rem' } },
        '直接開口說話即可，不用按任何按鈕。停頓一下考官就會接話。'),
      el('div', { class: 'cbt-livescore', id: 'sp-live' }),
      el('div', { class: 'cbt-chat', id: 'sp-chat' }),
      el('div', { class: 'cbt-actions', style: { justifyContent: 'center' } },
        el('button', {
          class: 'cbt-btn',
          onclick: (e) => {
            if (!liveSend({ type: 'nudge' }, e.target)) return;
            setStage('請考官接話…');
          },
        }, '🔔 叫考官接話'),
        el('button', {
          class: 'cbt-btn',
          onclick: (e) => { if (liveSend({ type: 'skip' }, e.target)) setStage('切換中…'); },
        }, '進入下一部分 →'),
        el('button', {
          class: 'cbt-btn danger',
          onclick: async (e) => {
            const ok = await Exam.dlg({
              title: '結束口說測驗？',
              body: el('p', {}, '結束之後就不能再說話了，系統會立刻開始評分。'),
              actions: [{ label: '再考一下', value: false }, { label: '確定結束', primary: true, value: true }],
            });
            if (!ok) return;
            if (liveSend({ type: 'finish' }, e.target)) setStage('正在結束…');
          },
        }, '結束測驗')));
  }

  /**
   * 送控制訊息給伺服器。
   * 以前是 `S.ws?.send(...)` —— 連線斷掉時整句是 undefined，按鈕按下去
   * 完全沒有任何反應，學生只會覺得「這顆按鈕壞了」。
   */
  function liveSend(msg, btn) {
    if (S.ws?.readyState !== 1) {
      toast('與考官的連線已中斷，請重新整理頁面', 'err');
      return false;
    }
    try {
      S.ws.send(JSON.stringify(msg));
      if (btn) {
        btn.disabled = true;
        setTimeout(() => { btn.disabled = false; }, 1200);
      }
      return true;
    } catch (e) {
      toast(`送不出去：${e.message}`, 'err');
      return false;
    }
  }

  const setStage = (t) => { const n = $('#sp-stage'); if (n) n.textContent = t; };
  const setQline = (t) => { const n = $('#sp-q'); if (n) n.textContent = t; };
  const setOrb = (cls) => { const n = $('#sp-orb'); if (n) n.className = `cbt-orb ${cls}`; };

  function setTimerText(left, total) {
    const n = $('#sp-timer');
    if (!n) return;
    n.style.display = '';
    n.textContent = fmtTime(Math.max(0, left));
    n.className = 'cbt-bigtimer' + (left <= 10 ? ' danger' : left <= total * 0.25 ? ' warn' : '');
  }

  function fillCue(cc) {
    const n = $('#sp-cue');
    if (!n) return;
    n.style.display = '';
    n.replaceChildren(
      el('b', {}, cc.topic || ''),
      el('div', { class: 'small', style: { margin: '.45rem 0 .1rem', opacity: '.75' } }, 'You should say:'),
      el('ul', {}, (cc.bullets || []).map((b) => el('li', {}, b))));
  }

  function addChat(role, text) {
    S.chat.push({ role, text });
    const box = $('#sp-chat');
    if (!box) return;
    box.append(el('div', { class: role }, role === 'ex' ? `考官：${text}` : `你：${text}`));
    box.scrollTop = box.scrollHeight;
  }

  function showLive(msg) {
    S.live = msg;
    const box = $('#sp-live');
    if (!box) return;
    const L = { FC: '流利', LR: '詞彙', GRA: '文法', PRO: '發音' };
    box.replaceChildren(
      el('span', { class: 'chip' }, '即時estimate', el('b', {}, UI.band(msg.band))),
      ...Object.entries(L).map(([k, lab]) =>
        el('span', { class: 'chip' }, lab, el('b', {}, String(msg.criteria?.[k] ?? '—')))),
      msg.note ? el('span', { class: 'chip', style: { opacity: '.75' } }, msg.note) : null);
  }

  // ══ 輪替模式（沒有 Realtime 端點時的備援）═════════════════
  function buildSteps(paper) {
    const mod = (paper.modules || []).find((m) => m.module === 'speaking');
    const steps = [];
    if (!mod) return steps;
    for (const sec of mod.sections || []) {
      for (const g of sec.groups || []) {
        if (g.type !== 'speaking_part') continue;
        for (const q of g.questions || []) {
          const part = Number(q.part) || 1;
          if (part === 2) {
            const cc = q.cueCard || {};
            steps.push({ kind: 'prep', part: 2, cueCard: cc, prepSec: cc.prepSec || 60 });
            steps.push({ kind: 'talk', part: 2, cueCard: cc, maxSec: cc.talkSec || 120,
              question: cc.topic || 'Describe the topic on the card.' });
            for (const r of q.rounding || []) steps.push({ kind: 'ask', part: 2, question: r, maxSec: 30 });
          } else {
            for (const it of (q.items?.length ? q.items : (q.topic ? [q.topic] : []))) {
              steps.push({ kind: 'ask', part, topic: q.topic || '', question: it, maxSec: part === 1 ? 50 : 75 });
            }
            if (q.dynamic) steps.push({ kind: 'follow', part, topic: q.topic || '', maxSec: part === 1 ? 50 : 75 });
          }
        }
      }
    }
    return steps;
  }

  function startTurnMode() {
    S.i = 0;
    S.history = { 1: [], 2: [], 3: [] };
    nextStep();
  }

  async function speak(text) {
    if (!text) return;
    try {
      const res = await API.post('/speaking/tts', { text }, { raw: true });
      const blob = await res.blob();
      await new Promise((resolve) => {
        const a = new Audio(URL.createObjectURL(blob));
        a.onended = a.onerror = resolve;
        a.play().catch(resolve);
      });
    } catch {
      await new Promise((resolve) => {
        if (!window.speechSynthesis) return resolve();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-GB'; u.rate = 0.95;
        const v = speechSynthesis.getVoices().find((x) => /en-GB/i.test(x.lang));
        if (v) u.voice = v;
        u.onend = u.onerror = resolve;
        speechSynthesis.speak(u);
      });
    }
  }

  async function nextStep() {
    if (S.i >= S.steps.length) return finishTurnMode();
    const step = S.steps[S.i];
    if (step.kind === 'prep') return turnPrep(step);
    if (step.kind === 'follow') {
      let q = '';
      try {
        const r = await API.post(`/speaking/${S.attemptId}/follow-up`, {
          part: step.part, topic: step.topic, history: S.history[step.part] || [],
        });
        q = r.question;
      } catch { q = ''; }
      if (!q) { S.i += 1; return nextStep(); }
      step.question = q;
    }
    turnAsk(step);
  }

  function turnPrep(step) {
    let left = step.prepSec;
    shell(
      el('div', { class: 'stage' }, 'PART 2 · 準備時間'),
      el('div', { class: 'cbt-cue', id: 'sp-cue' }),
      el('p', { class: 'small', style: { opacity: '.75' } }, '你有 1 分鐘準備，時間到會自動開始錄音。'),
      el('div', { class: 'cbt-bigtimer', id: 'sp-timer' }, fmtTime(left)),
      el('div', { class: 'cbt-actions', style: { justifyContent: 'center' } },
        el('button', { class: 'cbt-btn', onclick: () => { clearInterval(t); S.i += 1; nextStep(); } }, '我準備好了')));
    fillCue(step.cueCard);
    speak('Now, I am going to give you a topic and I would like you to talk about it for one to two minutes. Before you talk you have one minute to think about what you are going to say.');
    const t = setInterval(() => {
      left -= 1;
      setTimerText(left, step.prepSec);
      if (left <= 0) { clearInterval(t); S.i += 1; nextStep(); }
    }, 1000);
  }

  function turnAsk(step) {
    shell(
      el('div', { class: 'stage' }, `PART ${step.part} · ${S.i + 1} / ${S.steps.length}`),
      step.kind === 'talk' && step.cueCard
        ? el('div', { class: 'cbt-cue', id: 'sp-cue' })
        : el('div', { class: 'qline' }, step.question),
      el('div', { class: 'small', id: 'sp-status', style: { opacity: '.75' } }, '考官提問中…'),
      el('div', { class: 'cbt-bigtimer', id: 'sp-timer' }, '00:00'),
      el('button', { class: 'cbt-orb', id: 'sp-orb', disabled: true, onclick: toggleRec },
        el('span', { class: 'ring' }), '🎙'),
      el('div', { class: 'cbt-level' }, el('i', { id: 'sp-level' })),
      el('div', { class: 'cbt-livescore', id: 'sp-live' }),
      el('div', { class: 'cbt-actions', style: { justifyContent: 'center' } },
        el('button', { class: 'cbt-btn', onclick: () => speak(step.question) }, '🔁 再聽一次'),
        el('button', { class: 'cbt-btn', onclick: () => { if (S.recording) stopRec(true); S.i += 1; nextStep(); } }, '略過 →')));
    if (step.kind === 'talk' && step.cueCard) fillCue(step.cueCard);
    if (S.live) showLive(S.live);

    (async () => {
      await speak(step.question);
      const b = $('#sp-orb');
      if (b) b.disabled = false;
      const st = $('#sp-status');
      if (st) st.textContent = '請按麥克風開始回答，說完再按一次';
      if (step.kind === 'talk') setTimeout(() => { if (!S.recording) toggleRec(); }, 400);
    })();
  }

  let recTimer = null, startedAt = 0, turnRecorder = null, turnChunks = [], browserText = '', recog = null;

  function toggleRec() { S.recording ? stopRec() : startRec(); }

  function startRec() {
    const step = S.steps[S.i];
    turnChunks = [];
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    turnRecorder = new MediaRecorder(S.stream, mime ? { mimeType: mime } : undefined);
    turnRecorder.ondataavailable = (e) => { if (e.data.size) turnChunks.push(e.data); };
    turnRecorder.onstop = onRecStop;
    turnRecorder.start();
    S.recording = true;
    startedAt = Date.now();
    $('#sp-orb')?.classList.add('candidate');
    const st = $('#sp-status'); if (st) st.textContent = '錄音中…說完後再按一次麥克風';
    startBrowserStt();
    meterTurn();
    recTimer = setInterval(() => {
      const sec = (Date.now() - startedAt) / 1000;
      setTimerText(Math.max(0, (step.maxSec || 60) - sec), step.maxSec || 60);
      if (sec >= (step.maxSec || 60)) stopRec();
    }, 250);
  }

  function meterTurn() {
    try {
      S.ctx = S.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const an = S.ctx.createAnalyser();
      an.fftSize = 512;
      S.ctx.createMediaStreamSource(S.stream).connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const loop = () => {
        if (!S.recording) { const b = $('#sp-level'); if (b) b.style.width = '0'; return; }
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        const b = $('#sp-level');
        if (b) b.style.width = `${Math.min(100, (peak / 55) * 100)}%`;
        requestAnimationFrame(loop);
      };
      loop();
    } catch {}
  }

  function startBrowserStt() {
    browserText = '';
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R) return;
    try {
      recog = new R();
      recog.lang = 'en-GB'; recog.continuous = true; recog.interimResults = true;
      recog.onresult = (e) => {
        let t = '';
        for (let i = 0; i < e.results.length; i++) if (e.results[i].isFinal) t += `${e.results[i][0].transcript} `;
        browserText = t.trim();
      };
      recog.onerror = () => {};
      recog.start();
    } catch { recog = null; }
  }

  function stopRec(discard = false) {
    if (!S.recording) return;
    S.recording = false;
    S.discard = discard;
    clearInterval(recTimer);
    try { recog?.stop(); } catch {}
    recog = null;
    $('#sp-orb')?.classList.remove('candidate');
    try { turnRecorder.stop(); } catch { onRecStop(); }
  }

  async function onRecStop() {
    const step = S.steps[S.i];
    const duration = Math.round((Date.now() - startedAt) / 1000);
    const blob = new Blob(turnChunks, { type: turnRecorder?.mimeType || 'audio/webm' });
    if (S.discard || !blob.size) { S.discard = false; return; }

    const st = $('#sp-status'); if (st) st.textContent = '辨識中…';
    const orb = $('#sp-orb'); if (orb) orb.disabled = true;

    const qIndex = S.qIndexByPart[step.part]++;
    const fd = new FormData();
    fd.append('audio', blob, `p${step.part}_q${qIndex}.webm`);
    fd.append('part', String(step.part));
    fd.append('qIndex', String(qIndex));
    fd.append('question', step.question || step.cueCard?.topic || '');
    fd.append('duration', String(duration));
    if (browserText) fd.append('browserTranscript', browserText);

    let transcript = browserText;
    try {
      const r = await API.post(`/speaking/${S.attemptId}/response`, fd);
      transcript = r.transcript || browserText;
      /* 語音辨識失敗時，練習模式會提示，但正式考試以前是默默吞掉的 ——
         學生看到「已記錄」就繼續往下考，等分數出來才發現這一題根本沒有逐字稿。
         錄音檔有存下來，老師可以補救，但一定要當場講。 */
      if (r?.sttError && !transcript.trim()) {
        toast('這一題沒有辨識到文字，錄音已存下來，請舉手告訴監考老師', 'err');
      } else if (r?.sttError) {
        toast('語音辨識不穩，已改用瀏覽器辨識的結果', 'warn');
      }
    } catch (e) { toast(`上傳失敗：${e.message}`, 'err'); }

    if (!transcript.trim()) {
      toast('這一題沒有錄到內容，可能會影響分數', 'err');
    }

    S.history[step.part] = S.history[step.part] || [];
    S.history[step.part].push({ question: step.question || '', transcript });

    // 即時評分
    API.post(`/speaking/${S.attemptId}/score-now`, {}).then((r) => {
      if (r?.live) showLive({ band: r.live.band, criteria: r.live.criteria, note: r.live.note });
    }).catch(() => {});

    if (st) st.textContent = transcript ? `已記錄：${transcript.slice(0, 80)}…` : '已記錄';
    setTimeout(() => { S.i += 1; nextStep(); }, 1000);
  }

  async function finishTurnMode() {
    shell(el('div', { class: 'stage' }, '結束'), el('h2', {}, '評分中…'),
      el('p', {}, '正在依四大評分標準計算成績，請稍候。'));
    await speak('Thank you. That is the end of the speaking test.');
    await uploadBackupRecording();
    let result = null;
    try { result = await API.post(`/speaking/${S.attemptId}/finalize`, {}); } catch {}
    renderFinish(result);
  }

  // ══ 結束畫面 ══════════════════════════════════════════════
  function renderFinish(score) {
    teardown();
    const L = { FC: '流利度與連貫性', LR: '詞彙豐富度', GRA: '文法多樣性與準確度', PRO: '發音' };
    shell(
      el('div', { class: 'stage' }, '結束'),
      el('h2', {}, '口說測驗結束'),
      S.mode !== 'ai'
        ? el('p', {}, '你的錄音與逐字稿已送出，將由老師評分。')
        : score && score.band != null
          ? el('div', {},
              el('p', {}, '以下是 AI 考官的即時評分結果：'),
              el('div', { class: 'cbt-bigtimer' }, `Band ${UI.band(score.band)}`),
              el('div', { class: 'cbt-livescore' }, Object.entries(L).map(([k, lab]) =>
                el('span', { class: 'chip' }, lab, el('b', {}, String(score.criteria?.[k] ?? '—'))))),
              score.feedback?.summary_zh ? el('p', { style: { marginTop: '1rem' } }, score.feedback.summary_zh) : null,
              el('p', { class: 'small', style: { opacity: '.7' } }, '完整的逐題評語與建議會在交卷後的成績單裡。'))
          : el('p', {}, '你的錄音與逐字稿已送出，成績會在交卷後一併公布。'),
      el('div', { class: 'cbt-actions', style: { justifyContent: 'center' } },
        el('button', { class: 'cbt-btn primary', onclick: () => S.onDone?.() }, '回到科目清單 →')));
  }

  function teardown() {
    S.finished = true;
    clearInterval(S.timer);
    clearInterval(recTimer);
    try { S.ws?.close(); } catch {}
    try { S.worklet?.disconnect(); } catch {}
    try { S.ctx?.close(); } catch {}
    try { S.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { recog?.stop(); } catch {}
  }

  return { run, buildSteps };
})();
