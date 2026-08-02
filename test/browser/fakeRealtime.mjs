/* 更忠實的假 Realtime 端點。
   重點是把「真的 OpenAI 會怎麼回」照做，尤其是：
     · server_vad + create_response=true → 學生一停頓，端點自己就發起回應
     · response.cancel 但沒有進行中的回應 → 回 error
     · response.create 但已經有進行中的回應 → 回 error
   這三件事正是介面上摸不到、但把對話搞爛的東西。 */
import http from 'http';
import wspkg from 'ws';
const { WebSocketServer } = wspkg;

const PORT = 4478;
export const log = [];
export const connections = [];
export const mode = { mute: false };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          band: 6.5, criteria: { FC: 6.5, LR: 6, GRA: 6.5, PRO: 7 },
          note_zh: '穩定', summary_zh: '整體表現中上。',
        }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }));
    }
    res.writeHead(404).end('{}');
  });
});

const wss = new WebSocketServer({ server, path: '/v1/realtime' });

wss.on('connection', (ws) => {
  const send = (o) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch {} };
  let session = {};
  let active = null;          // 進行中的回應
  let line = 0;
  const LINES = [
    'Good morning. Can you tell me your full name please?',
    'Thank you. Now let us talk about where you live.',
    'What do you like most about your hometown?',
    'Now I am going to give you a topic. Here is your topic.',
    'All right? Can you start speaking now please?',
    'Thank you. Now let us discuss this more generally.',
    'How do you think this will change in the future?',
  ];

  const vadCfg = () => (session.type === 'realtime' || session.audio)
    ? session.audio?.input?.turn_detection : session.turn_detection;

  const speak = (text, why) => {
    if (active) {
      log.push({ t: 'error_sent', why: 'already_active' });
      send({ type: 'error', error: { message: 'Conversation already has an active response' } });
      return;
    }
    log.push({ t: 'examiner_speaks', why, text: text.slice(0, 40) });
    let i = 0;
    const words = text.split(' ');
    const tick = () => {
      if (ws.readyState !== 1) return;
      send({ type: 'response.output_audio.delta', delta: Buffer.alloc(480).toString('base64') });
      send({ type: 'response.output_audio_transcript.delta', delta: `${words[i]} ` });
      i += 1;
      if (i < words.length) { active = setTimeout(tick, 10); return; }
      send({ type: 'response.output_audio_transcript.done', transcript: text });
      send({ type: 'response.done', response: {} });
      active = null;
    };
    active = setTimeout(tick, 10);
  };

  setTimeout(() => send({ type: 'session.created', session: {} }), 20);

  ws.on('message', (raw) => {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }

    if (ev.type === 'session.update') {
      session = ev.session || {};
      const v = vadCfg();
      log.push({ t: 'session.update', vad: v?.type || null,
        createResponse: v?.create_response, silenceMs: v?.silence_duration_ms,
        stage: (session.instructions || '').match(/CURRENT STAGE — ([^\n.]+)/)?.[1] || '?' });
      send({ type: 'session.updated', session });
      return;
    }
    if (ev.type === 'input_audio_buffer.append') { log.push({ t: 'audio_in' }); return; }
    if (ev.type === 'response.create') {
      log.push({ t: 'response.create' });
      if (!mode.mute) speak(LINES[Math.min(line++, LINES.length - 1)], 'response.create');
      return;
    }
    if (ev.type === 'response.cancel') {
      // 真的端點：沒有進行中的回應就回錯誤，這會變成學生畫面上的紅色 toast
      if (!active) {
        log.push({ t: 'error_sent', why: 'no_active_response' });
        send({ type: 'error', error: { message: 'Cancellation failed: no active response found' } });
        return;
      }
      log.push({ t: 'response.cancel' });
      clearTimeout(active); active = null;
      return;
    }
  });

  /** 學生開口（VAD 偵測到聲音）*/
  ws.speechStarted = () => send({ type: 'input_audio_buffer.speech_started' });

  /**
   * 學生停頓。這是關鍵：server_vad + create_response=true 時，
   * 端點會「自己」發起一次回應 —— 不管系統的 instructions 寫了什麼。
   */
  ws.speechStopped = ({ transcript = null } = {}) => {
    send({ type: 'input_audio_buffer.speech_stopped' });
    send({ type: 'input_audio_buffer.committed' });
    if (transcript) {
      send({ type: 'conversation.item.input_audio_transcription.completed', transcript });
    }
    const v = vadCfg();
    if (v?.create_response !== false) {
      setTimeout(() => speak(LINES[Math.min(line++, LINES.length - 1)], 'vad_auto'), 5);
    }
  };

  ws.killUpstream = () => { try { ws.close(); } catch {} };
  connections.push(ws);
});

server.listen(PORT, '127.0.0.1');
export { PORT };
export function stop() { try { wss.close(); server.close(); } catch {} }
