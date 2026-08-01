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

  log(...a) { console.log(`[rt:${this.attempt.id}]`, ...a); }

  // ── 連線到 Realtime 模型 ──────────────────────────────────
  async connectUpstream() {
    const { baseUrl, apiKey, model, protocol } = this.cfg;
    if (protocol !== 'openai') throw new Error('即時語音需要 OpenAI 相容的 Realtime 端點');
    if (!apiKey) throw new Error('尚未設定語音供應商的 API Key');

    const wsUrl = `${baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/realtime?model=${encodeURIComponent(model)}`;
    this.log('connect', wsUrl);

    const up = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'realtime=v1' },
    });
    this.upstream = up;

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('連線逾時')), 20000);
      up.once('open', () => { clearTimeout(t); resolve(); });
      up.once('error', (e) => { clearTimeout(t); reject(e); });
    });

    up.on('message', (raw) => this.onUpstream(raw));
    up.on('close', () => { if (!this.closed) this.send({ type: 'upstream_closed' }); });
    up.on('error', (e) => this.send({ type: 'error', message: e.message }));

    this.configureSession();
  }

  configureSession() {
    this.upstream.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: examinerInstructions(this.script, this.phase),
        voice: this.cfg.voice || 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: this.cfg.sttModel || 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
          create_response: true,
        },
        temperature: 0.8,
      },
    }));
  }

  /** 切換階段：更新指示，必要時要求模型立刻發話 */
  setPhase(phase, { speak = true, extra = '' } = {}) {
    if (this.closed) return;
    const done = this.turns.filter((t) => t.role === 'candidate').length;
    if (phase === 'part3' && this.part3StartTurns == null) this.part3StartTurns = done;
    if (phase === 'part2_round' && this.roundStartTurns == null) this.roundStartTurns = done;
    this.phase = phase;
    this.log('phase →', phase);
    this.configureSession();
    this.send({
      type: 'phase',
      phase,
      cueCard: phase.startsWith('part2') ? this.script.part2 : null,
      elapsed: Math.round((Date.now() - this.startedAt) / 1000),
    });
    if (speak && this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(JSON.stringify({
        type: 'response.create',
        response: { instructions: extra || undefined },
      }));
    }
  }

  // ── 上游事件 ──────────────────────────────────────────────
  async onUpstream(raw) {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }

    switch (ev.type) {
      case 'session.created':
        this.send({ type: 'ready' });
        // 開場白
        this.setPhase('intro');
        break;

      case 'input_audio_buffer.speech_started':
        this.send({ type: 'candidate_speaking', on: true });
        break;

      case 'input_audio_buffer.speech_stopped':
        this.send({ type: 'candidate_speaking', on: false });
        break;

      case 'response.audio.delta':
        // 直接把考官語音丟給瀏覽器播放
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
        this.send({ type: 'examiner_done' });
        // Part 2 指示唸完 → 開始 1 分鐘準備
        this.fire('examiner_done_hook');
        break;

      case 'error':
        this.log('upstream error', ev.error?.message);
        this.send({ type: 'error', message: ev.error?.message || '模型回報錯誤' });
        break;
      default:
        break;
    }
  }

  /** 把考生的一輪回答寫進資料庫 */
  async saveTurn(text) {
    const part = this.phase.startsWith('part2') ? 2 : this.phase === 'part3' ? 3 : 1;
    const lastExaminer = [...this.turns].reverse().find((t) => t.role === 'examiner');
    const idx = this.qIndex[part]++;
    const dur = Math.max(1, Math.round(text.split(/\s+/).length / 2.3));  // 依字數估算秒數
    try {
      await db.exec(
        `INSERT INTO speaking_responses (attempt_id, part, q_index, question, transcript, duration_sec)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE question=VALUES(question), transcript=VALUES(transcript),
           duration_sec=VALUES(duration_sec)`,
        [this.attempt.id, part, idx, lastExaminer?.text || '', text, dur]
      );
    } catch (e) { this.log('saveTurn', e.message); }
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
    this.phase = 'part2_prep';
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
      try { ws.send(JSON.stringify({ type: 'fatal', message: msg })); } catch {}
      ws.close();
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
    } catch (e) {
      try { session?.close(); } catch {}
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
      else if (msg.type === 'skip') session.maybeAdvance();
      else if (msg.type === 'next_phase') session.setPhase(msg.phase);
      else if (msg.type === 'finish') session.finish();
      else if (msg.type === 'cancel_response' && session.upstream?.readyState === WebSocket.OPEN) {
        session.upstream.send(JSON.stringify({ type: 'response.cancel' }));
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
    model: cfg.realtimeModel || 'gpt-4o-realtime-preview',
    voice: cfg.ttsVoice || 'alloy',
    sttModel: cfg.sttModel || 'whisper-1',
  };
}

/** 目前設定是否支援即時語音 */
async function isAvailable() {
  try {
    const c = await realtimeConfig();
    return { ok: c.protocol === 'openai' && !!c.apiKey && !!c.baseUrl, model: c.model, provider: c.protocol };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { attach, closeAll, isAvailable, realtimeConfig, buildScript, examinerInstructions, sessions };
