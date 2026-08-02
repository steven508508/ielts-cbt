'use strict';
/**
 * 口說即時語音對話 — WebSocket 中繼。
 *
 *   瀏覽器  ──(PCM16 24kHz)──►  本伺服器  ──►  Realtime 模型
 *          ◄──(考官語音+逐字稿)──         ◄──
 *
 * 伺服器負責：
 *   1. 保管 API 金鑰（不會外流到瀏覽器）
 *   2. 依官方流程驅動 Part 1 → Part 2（含 1 分鐘準備）→ Part 3
 *   3. 把逐字稿寫進資料庫，並持續累進更新四大標準的即時分數
 */
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const ai = require('./ai');
const aiTasks = require('./aiTasks');
const bands = require('./bands');

const PATH = '/ws/speaking';

// ── 依試卷組出考官的完整腳本 ──────────────────────────────────
function buildScript(paper) {
  const mod = (paper.modules || []).find((m) => m.module === 'speaking');
  const out = { part1: [], part2: null, part3: [], rounding: [] };
  if (!mod) return out;
  for (const sec of mod.sections || []) {
    for (const g of sec.groups || []) {
      if (g.type !== 'speaking_part') continue;
      for (const q of g.questions || []) {
        const part = Number(q.part) || 1;
        if (part === 2) {
          out.part2 = q.cueCard || null;
          out.rounding = q.rounding || [];
        } else if (part === 3) {
          out.part3.push({ topic: q.topic || '', items: q.items || [] });
        } else {
          out.part1.push({ topic: q.topic || '', items: q.items || [] });
        }
      }
    }
  }
  return out;
}

function examinerInstructions(script, phase) {
  const base = `You are a certified IELTS Speaking examiner conducting a real face-to-face style
speaking test in British English. Behave exactly like a real examiner:

- Speak at a natural, unhurried pace. Be polite, neutral and friendly but NEVER give feedback,
  praise, corrections or scores. Never say "good", "well done", "that's interesting".
- Ask ONE question at a time and then STOP and listen. Do not stack questions.
- Short natural acknowledgements are fine ("Right.", "Mm-hm.", "OK.") before the next question.
- If the candidate gives a one-word answer, ask a short natural follow-up ("Why is that?", "Can you tell me more?").
- If the candidate does not understand, you may repeat the question once, but do not rephrase
  Part 2 cue-card content.
- Do NOT talk about being an AI. Do not read out stage directions.
- Keep your own turns short — the candidate should be speaking most of the time.`;

  const p1 = script.part1.map((t, i) =>
    `  Topic ${i + 1} — ${t.topic}:\n${t.items.map((q) => `    · ${q}`).join('\n')}`).join('\n');
  const p3 = script.part3.map((t) =>
    `  ${t.topic}:\n${t.items.map((q) => `    · ${q}`).join('\n')}`).join('\n');
  const cue = script.part2
    ? `  Topic: ${script.part2.topic}\n  You should say:\n${(script.part2.bullets || []).map((b) => `    · ${b}`).join('\n')}`
    : '  (no cue card supplied — invent an authentic IELTS Part 2 card)';

  const phases = {
    intro: `CURRENT STAGE — Introduction.
Say, in your own natural words: good morning/afternoon, introduce yourself as the examiner,
ask the candidate to tell you their full name, then ask where they are from. Then STOP.`,

    part1: `CURRENT STAGE — Part 1 (4–5 minutes).
Work through these topics in order, asking the questions roughly as written. You may add one
short natural follow-up per topic based on what the candidate said. Move to the next topic once
a topic has been covered.
${p1}`,

    part2_instruct: `CURRENT STAGE — Part 2 instructions.
Say exactly this idea in natural examiner language: "Now I'm going to give you a topic and I'd
like you to talk about it for one to two minutes. Before you talk you'll have one minute to think
about what you're going to say. You can make some notes if you wish. Here is your topic."
Then read the topic line ONCE (only the topic line, not the bullet points), and STOP talking.
The candidate now has one minute of silent preparation — do not speak again until told to.
${cue}`,

    part2_prep: `CURRENT STAGE — Part 2 preparation minute.
The candidate is silently making notes. Say NOTHING AT ALL. Do not prompt, do not repeat the
topic, do not ask if they are ready. Remain completely silent until you are told the time is up.
${cue}`,

    part2_talk: `CURRENT STAGE — Part 2 long turn.
Say: "All right? Remember you have one to two minutes for this, so don't worry if I stop you.
I'll tell you when the time is up. Can you start speaking now, please?" Then STOP and listen.
Do NOT interrupt the candidate while they speak. Stay silent until you are told the time is up.`,

    part2_round: `CURRENT STAGE — Part 2 rounding-off.
Say "Thank you." then ask these short questions one at a time:
${(script.rounding || []).map((q) => `    · ${q}`).join('\n') || '    · (ask one short related question)'}`,

    part3: `CURRENT STAGE — Part 3 (4–5 minutes).
Say "We've been talking about ..., and I'd like to discuss with you one or two more general
questions relating to this." Then discuss these areas, asking one question at a time and probing
the candidate's answers with natural follow-ups ("Why do you think that is?", "Do you think that
will change?").
${p3}`,

    end: `CURRENT STAGE — End of test.
Say "Thank you. That is the end of the speaking test." and nothing else.`,
  };

  return `${base}\n\n${phases[phase] || phases.part1}`;
}

/** 知道但不需要處理的事件，不用一直寫進日誌 */
const IGNORED_EVENTS = new Set([
  'session.updated', 'conversation.created', 'conversation.item.created',
  'conversation.item.added', 'conversation.item.done', 'conversation.item.truncated',
  'conversation.item.deleted', 'input_audio_buffer.committed', 'input_audio_buffer.cleared',
  'response.created', 'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done',
  'response.audio.done', 'rate_limits.updated',
  'conversation.item.input_audio_transcription.delta',
  'conversation.item.input_audio_transcription.segment',
]);

/** GA 改掉的事件名稱 → 舊名（內部一律用舊名處理，Beta 端點也能吃）*/
const GA_EVENT_ALIASES = {
  'response.output_audio.delta': 'response.audio.delta',
  'response.output_audio.done': 'response.audio.done',
  'response.output_audio_transcript.delta': 'response.audio_transcript.delta',
  'response.output_audio_transcript.done': 'response.audio_transcript.done',
  'response.output_text.delta': 'response.text.delta',
  'response.output_text.done': 'response.text.done',
  'conversation.item.audio_transcription.completed':
    'conversation.item.input_audio_transcription.completed',
};

/**
 * session.update 的內容。
 *
 * OpenAI 把 Realtime 轉成 GA 之後結構整個換了：audio.input / audio.output 巢狀、
 * format 從字串 "pcm16" 變成物件 {type:'audio/pcm', rate:24000}、
 * modalities → output_modalities，而且多了 session.type:'realtime'。
 * 抽成純函式才測得到，不用真的連上端點。
 */
/**
 * 每個階段的換手規則。
 *
 * 以前整場只用同一組設定：停頓 700 毫秒就自動叫考官接話。Part 1／3 一問一答
 * 是對的，但 Part 2 的長回答完全不行 —— 官方規則是考官**不能打斷**考生，
 * 而考生講一兩分鐘本來就會停下來想。實測學生在長回答中停頓三次，考官插話三次。
 * 準備的那一分鐘也一樣：學生自言自語做筆記，考官就會冒出來講話。
 *
 * createResponse=false 只是不自動接話，語音辨識照常跑，逐字稿不會少。
 */
const PHASE_TURN_TAKING = {
  // 考官不能開口的兩段
  part2_prep: { createResponse: false, silenceMs: 2000 },
  part2_talk: { createResponse: false, silenceMs: 2000 },
  // 一問一答。700 毫秒對考生太短了 —— 話講到一半換個氣就被搶走，
  // 這也是「講起來很不順」的一大原因。
  _default: { createResponse: true, silenceMs: 1100 },
};

/** 這些是中繼層自己該處理掉的協定雜訊，不該變成學生畫面上的紅字 */
const INTERNAL_ERRORS =
  /no active response|already has an active response|conversation_already_has_active_response|cancellation failed/i;

/** 哪些階段可以讓學生插話把考官打斷（Part 2 讀題與長回答不行）*/
const BARGE_IN_PHASES = new Set(['intro', 'part1', 'part2_round', 'part3']);

function turnTakingFor(phase) {
  return PHASE_TURN_TAKING[phase] || PHASE_TURN_TAKING._default;
}

function buildSessionPayload({ script, phase, cfg = {}, flavor = 'ga' }) {
  const instructions = examinerInstructions(script, phase);
  const voice = cfg.voice || 'alloy';
  const sttModel = cfg.sttModel || 'whisper-1';
  const tt = turnTakingFor(phase);
  const vad = {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: tt.silenceMs,
    create_response: tt.createResponse,
  };

  if (flavor === 'beta') {
    return {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions,
        voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: sttModel },
        turn_detection: vad,
        temperature: 0.8,
      },
    };
  }

  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: sttModel },
          turn_detection: vad,
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          voice,
        },
      },
    },
  };
}

// ── 每一場考試的狀態 ──────────────────────────────────────────
const sessions = new Map();   // attemptId → session

class Session {
  constructor({ ws, user, attempt, paper, cfg }) {
    this.ws = ws;
    this.user = user;
    this.attempt = attempt;
    this.paper = paper;
    this.cfg = cfg;
    this.script = buildScript(paper);
    this.phase = 'intro';
    this.flavor = 'ga';   // connectUpstream() 會改成實際談成的版本
    this.turns = [];               // {role:'examiner'|'candidate', text, at}
    this.qIndex = { 1: 0, 2: 0, 3: 0 };
    this.upstream = null;
    this.closed = false;
    this.pendingExaminer = '';
    this.lastScoreAtTurn = 0;
    this.phaseTimer = null;
    this.startedAt = Date.now();
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /**
   * 斷線重連時接回原本的進度。
   *
   * 以前 qIndex 一律從 0 開始，而 speaking_responses 的唯一鍵是
   * (attempt_id, part, q_index) —— 重連後的第一句話會直接蓋掉考試一開始
   * 的第一句話。實測考四句、斷線一次，資料庫最後只剩兩句。
   * 階段也一樣從 intro 重來，學生已經考到 Part 3 了考官又問一次名字。
   */
  async restore() {
    try {
      const rows = await db.query(
        'SELECT part, MAX(q_index) AS mx FROM speaking_responses WHERE attempt_id = ? GROUP BY part',
        [this.attempt.id]
      );
      for (const r of rows) {
        const p = Number(r.part);
        if (this.qIndex[p] != null) this.qIndex[p] = Number(r.mx) + 1;
      }
      const live = await db.one(
        'SELECT phase, transcript FROM speaking_live WHERE attempt_id = ?', [this.attempt.id]);
      const phase = live?.phase;
      // 準備／長回答那兩段的計時器沒有跟著存，接回去會卡住不動。
      // 退到「讀題」重來一次 Part 2 是最不傷的做法。
      const RESUMABLE = ['intro', 'part1', 'part2_round', 'part3'];
      if (phase && RESUMABLE.includes(phase)) this.phase = phase;
      else if (phase && phase.startsWith('part2')) this.phase = 'part1';
      // 把先前的對話讀回來，考官才知道已經聊過什麼、即時分數也才接得下去
      if (live?.transcript) {
        for (const line of String(live.transcript).split('\n')) {
          const m = line.match(/^(EXAMINER|CANDIDATE): ([\s\S]*)$/);
          if (m) this.turns.push({ role: m[1] === 'EXAMINER' ? 'examiner' : 'candidate', text: m[2], at: 0 });
        }
        this.lastScoreAtTurn = this.turns.filter((t) => t.role === 'candidate').length;
      }
      this.resumed = this.turns.length > 0 || this.phase !== 'intro';
      if (this.resumed) this.log('接回先前的進度：階段', this.phase, '已答', this.turns.filter((t) => t.role === 'candidate').length, '句');
    } catch (e) { this.log('restore', e.message); }
  }

  log(...a) { console.log(`[rt:${this.attempt.id}]`, ...a); }

  // ── 連線到 Realtime 模型 ──────────────────────────────────
  /**
   * GA 不能送 `OpenAI-Beta: realtime=v1`（送了直接被拒），Beta 端點卻一定要送。
   * 自架與代理的相容端點很多還停在 Beta，所以預設先試 GA，被拒絕就自動退回，
   * 老師不必知道自己接的是哪一版。
   */
  async connectUpstream() {
    const { apiKey, protocol } = this.cfg;
    if (protocol !== 'openai') throw new Error('即時語音需要 OpenAI 相容的 Realtime 端點');
    if (!apiKey) throw new Error('尚未設定語音供應商的 API Key');

    const want = ['ga', 'beta'].includes(this.cfg.apiFlavor) ? [this.cfg.apiFlavor] : ['ga', 'beta'];
    let lastErr = null;
    for (const flavor of want) {
      try {
        const up = await this.openUpstream(flavor);
        this.flavor = flavor;
        this.upstream = up;
        up.on('message', (raw) => this.onUpstream(raw));
        up.on('close', () => this.onUpstreamClosed());
        up.on('error', (e) => this.send({ type: 'error', message: e.message }));
        this.log('upstream ready', flavor);
        return;
      } catch (e) {
        lastErr = e;
        this.log(`upstream(${flavor}) 失敗：`, e.message);
      }
    }

    // 全部談不成。翻成老師看得懂、而且知道下一步的訊息。
    const raw = lastErr?.message || '連不上即時語音端點';
    let hint = '';
    if (/beta/i.test(raw)) {
      hint = 'OpenAI 已把 Realtime 轉成 GA，舊的 Beta 協定不再支援。'
        + '請到「系統設定 → 語音 → Realtime 協定版本」改成「自動偵測」或「強制 GA」。';
    } else if (/401|unauthor|api key|invalid_api_key/i.test(raw)) {
      hint = '請確認「系統設定 → AI」的 API Key 有開通 Realtime 權限。';
    } else if (/404|not found|model/i.test(raw)) {
      hint = '請確認「即時對話模型 Realtime」填的模型名稱正確（例如 gpt-realtime）。';
    }
    const err = new Error(hint ? `${raw}\n\n${hint}` : raw);
    err.friendly = !!hint;
    throw err;
  }

  /** 開一條上游連線，並確認 session 設定被接受 */
  openUpstream(flavor) {
    const { baseUrl, apiKey, model } = this.cfg;
    const wsUrl = `${baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/realtime?model=${encodeURIComponent(model)}`;
    this.log('connect', flavor, wsUrl);

    return new Promise((resolve, reject) => {
      const headers = { Authorization: `Bearer ${apiKey}` };
      if (flavor === 'beta') headers['OpenAI-Beta'] = 'realtime=v1';

      let up;
      try { up = new WebSocket(wsUrl, { headers }); } catch (e) { return reject(e); }

      let settled = false;
      let probe = null;
      let grace = null;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        if (probe) up.off('message', probe);
        up.removeAllListeners('error');
        up.removeAllListeners('unexpected-response');
        if (err) { try { up.close(); } catch { /* 本來就沒連上 */ } return reject(err); }
        return resolve(up);
      };
      const timer = setTimeout(() => finish(new Error('連線逾時')), 20000);

      up.once('unexpected-response', (_req, res) => finish(new Error(`端點回 HTTP ${res.statusCode}`)));
      up.once('error', (e) => finish(e));

      up.once('open', () => {
        try { up.send(JSON.stringify(this.sessionPayload(flavor))); }
        catch (e) { return finish(e); }

        // session.updated = 設定被接受；error = 這一版協定不對，換另一版
        probe = (raw) => {
          let ev;
          try { ev = JSON.parse(raw.toString()); } catch { return; }
          if (ev.type === 'session.updated') return finish(null);
          if (ev.type === 'error') return finish(new Error(ev.error?.message || 'session 設定被拒絕'));
          return undefined;
        };
        up.on('message', probe);

        // 有些相容端點根本不回 session.updated，等一下就當它接受了
        grace = setTimeout(() => finish(null), 3500);
      });
    });
  }

  /**
   * 上游掉線。
   *
   * 以前只送一個 upstream_closed 就沒了 —— 而前端根本沒有處理這個訊息，
   * 學生的畫面完全不會變，就只是考官從此再也不講話。網路抖一下就等於這一科報銷。
   * 現在自動重接，並且把先前的對話補回去讓考官接得下去。
   */
  async onUpstreamClosed() {
    if (this.closed || this.finishing) return;
    this.responseActive = false;
    this.upstreamRetries = (this.upstreamRetries || 0) + 1;
    if (this.upstreamRetries > 3) {
      return this.send({ type: 'upstream_closed', fatal: true,
        message: '與考官的連線中斷，重試多次仍然接不回來。錄音有存下來，請舉手告訴監考老師。' });
    }
    this.send({ type: 'upstream_closed', retrying: this.upstreamRetries,
      message: `與考官的連線中斷，正在重新接上（第 ${this.upstreamRetries} 次）…` });
    await new Promise((r) => setTimeout(r, 800 * this.upstreamRetries));
    if (this.closed || this.finishing) return;
    try {
      const up = await this.openUpstream(this.flavor);
      this.upstream = up;
      up.on('message', (raw) => this.onUpstream(raw));
      up.on('close', () => this.onUpstreamClosed());
      up.on('error', (e) => this.send({ type: 'error', message: e.message }));
      this.seedHistory();
      this.upstreamRetries = 0;
      this.send({ type: 'upstream_reopened', message: '考官回來了，請繼續。' });
      this.log('上游已重新接上');
    } catch (e) {
      this.log('上游重連失敗：', e.message);
      this.onUpstreamClosed();
    }
  }

  /** 重連後把先前的對話補給模型，否則考官會忘記聊過什麼、從頭再問一次 */
  seedHistory() {
    if (this.upstream?.readyState !== WebSocket.OPEN) return;
    for (const t of this.turns.slice(-12)) {
      this.upstream.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: t.role === 'examiner' ? 'assistant' : 'user',
          content: [{ type: t.role === 'examiner' ? 'output_text' : 'input_text', text: t.text }],
        },
      }));
    }
  }

  sessionPayload(flavor = this.flavor) {
    return buildSessionPayload({ script: this.script, phase: this.phase, cfg: this.cfg, flavor });
  }

  configureSession() {
    if (this.upstream?.readyState !== WebSocket.OPEN) return;
    this.upstream.send(JSON.stringify(this.sessionPayload()));
  }

  /** 切換階段：更新指示，必要時要求模型立刻發話 */
  setPhase(phase, { speak = true, extra = '' } = {}) {
    if (this.closed) return;
    const done = this.turns.filter((t) => t.role === 'candidate').length;
    if (phase === 'part3' && this.part3StartTurns == null) this.part3StartTurns = done;
    if (phase === 'part2_round' && this.roundStartTurns == null) this.roundStartTurns = done;
    this.phase = phase;
    this.log('phase →', phase);
    // 存起來，斷線重連時才接得回去
    db.exec('UPDATE speaking_live SET phase = ? WHERE attempt_id = ?', [phase, this.attempt.id])
      .catch(() => {});
    this.configureSession();
    this.send({
      type: 'phase',
      phase,
      cueCard: phase.startsWith('part2') ? this.script.part2 : null,
      elapsed: Math.round((Date.now() - this.startedAt) / 1000),
    });
    if (speak) this.requestResponse(extra);
  }

  /**
   * 請考官講話。
   *
   * 一定要先確認沒有正在進行的回應。以前是無條件送 response.create ——
   * 學生剛講完話、端點自己已經在產生回應時再送一次，端點會回
   * 「Conversation already has an active response」，那則錯誤原封不動
   * 變成學生畫面上的紅字。實測跑完一場會跳三次。
   */
  requestResponse(extra = '') {
    if (this.closed || this.upstream?.readyState !== WebSocket.OPEN) return false;
    const create = () => {
      if (this.closed || this.upstream?.readyState !== WebSocket.OPEN) return;
      this.upstream.send(JSON.stringify({
        type: 'response.create',
        response: extra ? { instructions: extra } : undefined,
      }));
    };
    if (this.responseActive) {
      // 換階段時舊的回應已經不合時宜了，先取消再重下
      this.upstream.send(JSON.stringify({ type: 'response.cancel' }));
      this.responseActive = false;
      setTimeout(create, 120);
      return true;
    }
    create();
    return true;
  }

  // ── 上游事件 ──────────────────────────────────────────────
  async onUpstream(raw) {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }

    // GA 改了好幾個事件名稱。統一翻回舊名再處理，底下就不用寫兩份。
    const type = GA_EVENT_ALIASES[ev.type] || ev.type;

    switch (type) {
      case 'session.created':
        // 連線與 session 設定已經在 openUpstream() 裡確認過了，
        // 開場白改在連上之後明確觸發 —— GA 握手時這顆事件已經被讀掉。
        break;

      case 'response.created':
        this.responseActive = true;
        break;

      case 'input_audio_buffer.speech_started': {
        /* 學生開口。以前是前端無條件送 cancel_response ——
           兩個問題：一是常常根本沒有進行中的回應，端點回
           「Cancellation failed: no active response found」，
           學生畫面就跳一則莫名其妙的紅字；二是沒戴耳機時考官自己的
           聲音會被麥克風收回去，考官因此把自己講到一半的話砍掉。
           改由伺服器判斷 —— 只有它知道考官到底在不在講話。 */
        const bargeIn = this.responseActive && BARGE_IN_PHASES.has(this.phase);
        if (bargeIn && this.upstream?.readyState === WebSocket.OPEN) {
          this.upstream.send(JSON.stringify({ type: 'response.cancel' }));
          this.responseActive = false;
        }
        // 記下這一題是考官問的哪一句。等逐字稿回來時考官可能已經在問下一題了，
        // 那時候再取「最後一句考官的話」就會把答案配到錯的題目上。
        this.questionForTurn = [...this.turns].reverse().find((t) => t.role === 'examiner')?.text || '';
        this.send({ type: 'candidate_speaking', on: true, bargeIn });
        break;
      }

      case 'input_audio_buffer.speech_stopped':
        this.send({ type: 'candidate_speaking', on: false });
        /* 學生講完了。正常情況下幾秒內會有逐字稿與考官的回應；
           都沒有的話代表上游卡住了 —— 以前學生只能對著安靜的畫面乾等，
           完全不知道要做什麼。 */
        clearTimeout(this.stallTimer);
        this.stallSince = Date.now();
        this.stallTimer = setTimeout(() => {
          if (this.closed || this.finishing) return;
          if (this.lastActivity && this.lastActivity > this.stallSince) return;
          this.log('stalled：講完話之後 12 秒沒有任何回應');
          this.send({
            type: 'stalled',
            message: '考官沒有接話。可以再說一次，或按「叫考官接話」。',
          });
        }, 12000);
        break;

      case 'response.audio.delta':
        // 直接把考官語音丟給瀏覽器播放
        this.lastActivity = Date.now();
        this.send({ type: 'audio', delta: ev.delta });
        break;

      case 'response.audio_transcript.delta':
        this.pendingExaminer += ev.delta || '';
        this.send({ type: 'examiner_partial', text: this.pendingExaminer });
        break;

      case 'response.audio_transcript.done':
      case 'response.text.done': {
        const text = (ev.transcript || ev.text || this.pendingExaminer || '').trim();
        this.pendingExaminer = '';
        if (text) {
          this.turns.push({ role: 'examiner', text, at: Date.now() });
          this.send({ type: 'examiner', text });
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        this.lastActivity = Date.now();
        clearTimeout(this.stallTimer);
        const text = (ev.transcript || '').trim();
        if (!text) break;
        this.turns.push({ role: 'candidate', text, at: Date.now() });
        this.send({ type: 'candidate', text });
        await this.saveTurn(text);
        this.maybeScore();
        this.maybeAdvance();
        break;
      }

      case 'response.done':
        this.responseActive = false;
        this.send({ type: 'examiner_done' });
        // Part 2 指示唸完 → 開始 1 分鐘準備
        this.fire('examiner_done_hook');
        break;

      // 學生的語音轉不出文字。以前這顆事件被 default 吞掉，
      // 症狀就是「講了半天逐字稿一片空白、考官也不接話」，
      // 而畫面上完全沒有任何線索。
      case 'conversation.item.input_audio_transcription.failed': {
        const why = ev.error?.message || '語音辨識失敗';
        this.log('transcription failed', why);
        this.sttFails = (this.sttFails || 0) + 1;
        this.send({
          type: 'stt_failed',
          message: this.sttFails >= 2
            ? `語音辨識連續失敗（${why}）。錄音有存下來，請舉手告訴監考老師。`
            : '這一句沒有辨識出文字，請再說一次。',
        });
        break;
      }

      case 'error': {
        const m = ev.error?.message || '模型回報錯誤';
        this.log('upstream error', m);
        /* 協定層的雜訊不要丟到學生臉上 —— 他看到一句英文的
           「Cancellation failed: no active response found」只會慌，
           而且完全無從處理。記在伺服器日誌就好。 */
        if (INTERNAL_ERRORS.test(m)) break;
        this.send({ type: 'error', message: m });
        break;
      }

      default:
        /* 沒處理到的事件一律記下來。上游改版（例如 Beta → GA）時，
           被默默吞掉的新事件名稱就是最難查的那一種問題 ——
           至少要在伺服器日誌裡看得到它出現過。 */
        if (!IGNORED_EVENTS.has(type)) {
          this.unknown = this.unknown || new Set();
          if (!this.unknown.has(type)) {
            this.unknown.add(type);
            this.log('未處理的上游事件：', type);
          }
        }
        break;
    }
  }

  /** 把考生的一輪回答寫進資料庫 */
  async saveTurn(text) {
    const part = this.phase.startsWith('part2') ? 2 : this.phase === 'part3' ? 3 : 1;
    // 學生開口那一刻的題目才是他在回答的題目。語音辨識與考官的回應是兩條
    // 各自跑的管線，等逐字稿回來時考官可能已經問下一題了。
    const question = this.questionForTurn
      || [...this.turns].reverse().find((t) => t.role === 'examiner')?.text || '';
    const idx = this.qIndex[part]++;
    const dur = Math.max(1, Math.round(text.split(/\s+/).length / 2.3));  // 依字數估算秒數
    try {
      await db.exec(
        `INSERT INTO speaking_responses (attempt_id, part, q_index, question, transcript, duration_sec)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE question=VALUES(question), transcript=VALUES(transcript),
           duration_sec=VALUES(duration_sec)`,
        [this.attempt.id, part, idx, question, text, dur]
      );
    } catch (e) { this.log('saveTurn', e.message); }
  }

  /** 學生按「進入下一部分」：不看條件，直接跳到下一個階段 */
  forceAdvance() {
    if (this.closed || this.finishing) return;
    const order = ['intro', 'part1', 'part2_instruct', 'part3', 'end'];
    if (this.phase.startsWith('part2')) return this.setPhase('part3');
    const i = order.indexOf(this.phase);
    const next = i >= 0 ? order[i + 1] : 'part1';
    if (!next || next === 'end') return this.finish();
    if (next === 'part2_instruct') return this.startPart2();
    return this.setPhase(next);
  }

  /** 考官沒反應時再戳一次 */
  nudge() {
    if (this.closed || this.upstream?.readyState !== WebSocket.OPEN) {
      return this.send({ type: 'error', message: '與考官的連線已中斷，請重新整理頁面' });
    }
    this.log('nudge');
    if (this.responseActive) {
      // 考官其實正在講話，只是學生還沒聽到（或聲音被吃掉了）
      return this.send({ type: 'nudged', already: true });
    }
    this.requestResponse();
    this.send({ type: 'nudged' });
  }

  /** 依規則自動推進階段 */
  maybeAdvance() {
    const candidateTurns = this.turns.filter((t) => t.role === 'candidate').length;
    const elapsed = (Date.now() - this.startedAt) / 1000;

    if (this.phase === 'intro' && candidateTurns >= 2) {
      return this.setPhase('part1');
    }
    if (this.phase === 'part1') {
      const target = Math.max(8, this.script.part1.reduce((n, t) => n + (t.items?.length || 0), 0));
      if (candidateTurns >= target + 2 || elapsed > 330) return this.startPart2();
    }
    if (this.phase === 'part2_round') {
      const done = this.turns.filter((t) => t.role === 'candidate').length;
      if (done >= this.roundStartTurns + (this.script.rounding?.length || 1)) {
        return this.setPhase('part3');
      }
    }
    if (this.phase === 'part3') {
      const total = this.script.part3.reduce((n, t) => n + (t.items?.length || 0), 0);
      if (candidateTurns >= this.part3StartTurns + Math.min(total, 7) || elapsed > 840) {
        return this.finish();
      }
    }
  }

  /** Part 2：讀題 → 1 分鐘準備 → 最多 2 分鐘長回答 → 收尾提問 */
  startPart2() {
    if (!this.script.part2) return this.setPhase('part3');
    this.setPhase('part2_instruct');

    // 等考官把指示唸完（response.done）再開始 1 分鐘準備
    const waitDone = setTimeout(() => this.beginPrep(), 14000);
    this.once('examiner_done_hook', () => { clearTimeout(waitDone); this.beginPrep(); });
  }

  beginPrep() {
    if (this.phase !== 'part2_instruct' || this.closed) return;
    const prepSec = this.script.part2?.prepSec || 60;
    this.send({ type: 'prep', seconds: prepSec, cueCard: this.script.part2 });
    // setPhase(speak:false)，不是直接改 this.phase ——
    // 直接改的話新的換手設定（這一分鐘考官不准出聲）根本沒送到端點，
    // 學生一邊做筆記一邊碎念，考官就會插進來講話。
    this.setPhase('part2_prep', { speak: false });
    clearTimeout(this.phaseTimer);
    this.phaseTimer = setTimeout(() => {
      if (this.closed) return;
      this.setPhase('part2_talk');
      const talkSec = this.script.part2?.talkSec || 120;
      this.send({ type: 'talk', seconds: talkSec });
      clearTimeout(this.phaseTimer);
      this.phaseTimer = setTimeout(() => {
        if (this.closed) return;
        this.roundStartTurns = this.turns.filter((t) => t.role === 'candidate').length;
        this.setPhase('part2_round', { extra: 'The two minutes are up. Say "Thank you." and ask the rounding-off question.' });
      }, (talkSec + 12) * 1000);
    }, prepSec * 1000);
  }

  once(name, fn) { (this._hooks ||= {})[name] = fn; }
  fire(name) { const f = this._hooks?.[name]; if (f) { delete this._hooks[name]; f(); } }

  /** 每 3 輪更新一次即時分數 */
  maybeScore() {
    const n = this.turns.filter((t) => t.role === 'candidate').length;
    if (n - this.lastScoreAtTurn < 3) return;
    this.lastScoreAtTurn = n;
    this.scoreNow().catch(() => {});
  }

  async scoreNow(final = false) {
    const transcript = this.turns
      .map((t) => `${t.role === 'examiner' ? 'EXAMINER' : 'CANDIDATE'}: ${t.text}`)
      .join('\n');
    if (!transcript.trim()) return null;
    const seconds = Math.round((Date.now() - this.startedAt) / 1000);

    const out = await aiTasks.scoreSpeakingLive({
      transcript, seconds, final, userId: this.user.id,
    });
    const band = out.band != null ? bands.roundHalfBand(Number(out.band)) : bands.criteriaToBand(out.criteria);

    await db.exec(
      `INSERT INTO speaking_live (attempt_id, part, turns, criteria, band, notes, transcript, status)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE part=VALUES(part), turns=VALUES(turns), criteria=VALUES(criteria),
         band=VALUES(band), notes=VALUES(notes), transcript=VALUES(transcript), status=VALUES(status)`,
      [this.attempt.id, Number(String(this.phase).replace(/\D/g, '')) || 1,
       this.turns.filter((t) => t.role === 'candidate').length,
       JSON.stringify(out.criteria || {}), band, out.note_zh || '', transcript,
       final ? 'final' : 'live']
    );
    this.send({ type: 'live_score', criteria: out.criteria, band, note: out.note_zh });
    return { criteria: out.criteria, band, feedback: out };
  }

  /** 結束：立刻算出正式分數 */
  async finish() {
    if (this.finishing) return;
    this.finishing = true;
    clearTimeout(this.phaseTimer);
    this.setPhase('end');
    this.send({ type: 'finishing' });

    this.finishTimer = setTimeout(async () => {
      try {
        const responses = await db.query(
          'SELECT part, q_index, question, transcript, duration_sec FROM speaking_responses WHERE attempt_id = ? ORDER BY part, q_index',
          [this.attempt.id]
        );
        const graded = await aiTasks.gradeSpeaking({ responses, userId: this.user.id });
        const band = graded.band != null ? bands.roundHalfBand(Number(graded.band)) : bands.criteriaToBand(graded.criteria);
        await db.exec(
          `INSERT INTO module_results (attempt_id, module, band, criteria, feedback, graded_by, graded_at)
           VALUES (?,'speaking',?,?,?,'ai',NOW())
           ON DUPLICATE KEY UPDATE band=VALUES(band), criteria=VALUES(criteria),
             feedback=VALUES(feedback), graded_by='ai', graded_at=NOW()`,
          [this.attempt.id, band, JSON.stringify(graded.criteria || {}), JSON.stringify(graded)]
        );
        await db.exec("UPDATE speaking_live SET status='final' WHERE attempt_id=?", [this.attempt.id]);
        this.send({ type: 'final_score', band, criteria: graded.criteria, feedback: graded });
      } catch (e) {
        this.send({ type: 'error', message: `評分失敗：${e.message}` });
      } finally {
        this.send({ type: 'done' });
      }
    }, 2500);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.phaseTimer);
    clearTimeout(this.finishTimer);
    clearTimeout(this.stallTimer);
    try { this.upstream?.close(); } catch {}
    try { this.ws?.close(); } catch {}
    // 只刪掉「自己」。同一場考試若已經有新的連線接手，
    // 舊連線關閉時不能把新的那一個從 map 裡刪掉。
    if (sessions.get(this.attempt.id) === this) sessions.delete(this.attempt.id);
  }
}

// ── 掛載到 HTTP server ────────────────────────────────────────
function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith(PATH)) {
      // 不 destroy 的話，每一個打錯路徑的 upgrade 都會留下一個開著的 socket
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const attemptId = Number(url.searchParams.get('attemptId'));
    let session = null;

    const fail = (msg) => {
      // 等 send 的 callback 再關，不然訊息還在緩衝區就被關掉了
      try {
        ws.send(JSON.stringify({ type: 'fatal', message: msg }), () => {
          try { ws.close(); } catch { /* 已經斷了 */ }
        });
        setTimeout(() => { try { ws.close(); } catch { /* 已經斷了 */ } }, 1500);
      } catch {
        try { ws.close(); } catch { /* 已經斷了 */ }
      }
    };

    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const user = await db.one('SELECT id, name, username, role, active FROM users WHERE id = ?', [payload.uid]);
      if (!user || !user.active) return fail('帳號無效');

      const attempt = await db.one('SELECT * FROM attempts WHERE id = ?', [attemptId]);
      if (!attempt) return fail('找不到這場考試');
      if (attempt.user_id !== user.id && user.role === 'student') return fail('權限不足');

      const test = await db.one('SELECT content FROM tests WHERE id = ?', [attempt.test_id]);
      const paper = JSON.parse(test.content);

      const cfg = await realtimeConfig();
      session = new Session({ ws, user, attempt, paper, cfg });
      // 先把先前的進度讀回來，connectUpstream() 才會用正確的階段送 session.update
      await session.restore();

      // 連上游可能會丟出例外（金鑰錯、逾時）。先 set 再 connect 的話，
      // 失敗時會直接 return，下面的 close 監聽根本沒註冊到，
      // 這筆 session（連同整份試卷 JSON）就永遠留在 map 裡。
      await session.connectUpstream();

      // 同一場考試若已經有連線，先把舊的收掉再接手
      const prev = sessions.get(attemptId);
      if (prev && prev !== session) { try { prev.close(); } catch {} }
      sessions.set(attemptId, session);

      await db.exec("UPDATE attempts SET speaking_mode='realtime' WHERE id=?", [attemptId]);
      await db.exec(
        `INSERT INTO speaking_live (attempt_id, status) VALUES (?, 'live')
         ON DUPLICATE KEY UPDATE status='live'`,
        [attemptId]
      );

      session.send({ type: 'ready', api: session.flavor, resumed: !!session.resumed });
      if (session.resumed) {
        // 接續先前的考試：把對話補給模型、告訴前端進度，不要從頭再問一次名字
        session.seedHistory();
        session.send({ type: 'resumed', phase: session.phase,
          turns: session.turns.map((t) => ({ role: t.role, text: t.text })) });
        session.setPhase(session.phase, { speak: false });
      } else {
        session.setPhase('intro');
      }
    } catch (e) {
      /* 順序很重要：session.close() 會把「學生這一條」也關掉，
         先關再 send 的話那則 fatal 永遠送不出去，學生只看到連線莫名斷掉。
         這裡只收上游與計時器，錯誤訊息送出去之後才關學生那條。 */
      try {
        if (session) {
          session.closed = true;
          clearTimeout(session.phaseTimer);
          clearTimeout(session.finishTimer);
          try { session.upstream?.close(); } catch { /* 本來就沒連上 */ }
          if (sessions.get(attemptId) === session) sessions.delete(attemptId);
        }
      } catch { /* 清理失敗不影響回報 */ }
      return fail(e.message);
    }

    ws.on('message', (raw, isBinary) => {
      if (!session || session.closed) return;
      if (isBinary) {
        // 二進位 = 原始 PCM16，直接轉 base64 往上游送
        if (session.upstream?.readyState === WebSocket.OPEN) {
          session.upstream.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: Buffer.from(raw).toString('base64'),
          }));
        }
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'examiner_done_hook') session.fire('examiner_done_hook');
      // 以前接到 skip 是呼叫 maybeAdvance()，那是「檢查條件到了沒」——
      // 學生才講兩句時條件不成立，按鈕就完全沒反應。要的是強制跳。
      else if (msg.type === 'skip') session.forceAdvance();
      else if (msg.type === 'next_phase') session.setPhase(msg.phase);
      else if (msg.type === 'finish') session.finish();
      // 考官沒反應時讓學生自己戳一下
      else if (msg.type === 'nudge') session.nudge();
      // 打斷考官現在由伺服器在 speech_started 時判斷（它才知道考官在不在講話）。
      // 保留這個訊息是為了相容舊版前端，但一樣要先確認真的有回應在跑，
      // 否則端點會回「no active response」，變成學生畫面上的紅字。
      else if (msg.type === 'cancel_response') {
        if (session.responseActive && session.upstream?.readyState === WebSocket.OPEN) {
          session.upstream.send(JSON.stringify({ type: 'response.cancel' }));
          session.responseActive = false;
        }
      }
    });

    ws.on('close', () => session?.close());
    ws.on('error', () => session?.close());
  });

  // 心跳。學生直接闔上筆電時 TCP 是半開的，不會有 close 事件，
  // session、上游連線與計時器會一直留著（而且還在計費）。
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30_000);
  beat.unref?.();
  wss.on('close', () => clearInterval(beat));

  return wss;
}

/** 關機時把所有連線收乾淨，否則 server.close() 的 callback 永遠不會被呼叫 */
function closeAll(wss) {
  for (const s of [...sessions.values()]) { try { s.close(); } catch {} }
  sessions.clear();
  if (wss) {
    for (const ws of wss.clients) { try { ws.close(1001, 'server shutting down'); } catch {} }
    try { wss.close(); } catch {}
  }
}

/** 從系統設定推導出 Realtime 端點 */
async function realtimeConfig() {
  const cfg = await ai.getConfig();
  // 語音走 TTS 供應商的設定；若指定 anthropic 則不支援
  const role = cfg.ttsProvider && cfg.ttsProvider !== 'none' ? 'tts' : 'chat';
  const ep = ai.resolve(cfg, role);
  return {
    protocol: ep.protocol,
    baseUrl: ep.baseUrl,
    apiKey: ep.apiKey,
    model: cfg.realtimeModel || 'gpt-realtime',
    voice: cfg.ttsVoice || 'alloy',
    sttModel: cfg.sttModel || 'whisper-1',
    // auto = 先試 GA，被拒絕再退回 Beta
    apiFlavor: ['ga', 'beta'].includes(cfg.realtimeApi) ? cfg.realtimeApi : 'auto',
  };
}

/** 目前設定是否支援即時語音 */
async function isAvailable() {
  try {
    const c = await realtimeConfig();
    return {
      ok: c.protocol === 'openai' && !!c.apiKey && !!c.baseUrl,
      model: c.model, provider: c.protocol, api: c.apiFlavor || 'auto',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  attach, closeAll, isAvailable, realtimeConfig, buildScript, examinerInstructions,
  buildSessionPayload, GA_EVENT_ALIASES, sessions,
  PHASE_TURN_TAKING, BARGE_IN_PHASES, INTERNAL_ERRORS, turnTakingFor,
};
