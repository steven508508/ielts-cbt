/* 口說：錄好的示範對話。
 *
 * 真站是瀏覽器透過 WebSocket 跟伺服器上的即時語音考官全雙工對話。示範站沒有
 * 伺服器也不該替訪客付 API 的錢，所以這裡換掉 window.WebSocket，用一份腳本
 * 依照真實協定把訊息重播出來。
 *
 * 刻意「不」繞過前端的音訊管線：考官的聲音一樣是以 PCM16 24kHz 的 base64
 * 分塊送進 speaking.js 的 playChunk()，跟真的即時語音走同一條路。mp3 只是
 * 傳輸格式，在瀏覽器裡解碼、重取樣之後才送出去。
 *
 * 麥克風：不要求權限。getUserMedia 會拿到一條真的、但無聲的音軌，
 * 所以流程照跑，訪客不會被彈出權限視窗，也不會有人的聲音被送到任何地方。
 */
(function () {
  'use strict';

  const SCRIPT = window.DEMO_SPEAKING;
  const RATE = 24000;
  const CHUNK = 4800;           // 0.2 秒一塊，跟真的串流節奏接近

  // ── 無聲但真實的麥克風 ──────────────────────────────────────────────
  if (navigator.mediaDevices) {
    const realGUM = navigator.mediaDevices.getUserMedia?.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function (c) {
      if (!c || !c.audio) return realGUM ? realGUM(c) : Promise.reject(new Error('不支援'));
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dst = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;               // 完全無聲
      osc.connect(gain).connect(dst);
      osc.start();
      return dst.stream;
    };
    const realEnum = navigator.mediaDevices.enumerateDevices?.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async function () {
      const real = realEnum ? await realEnum().catch(() => []) : [];
      if (real.some((d) => d.kind === 'audioinput' && d.label)) return real;
      return [{ deviceId: 'demo-mic', kind: 'audioinput', label: '示範用麥克風', groupId: 'demo', toJSON: () => ({}) }];
    };
  }

  // ── mp3 → PCM16 @24k 的 base64 分塊 ─────────────────────────────────
  const audioCache = new Map();
  async function pcmChunks(url) {
    if (audioCache.has(url)) return audioCache.get(url);
    const buf = await fetch(url).then((r) => {
      if (!r.ok) throw new Error(`取不到 ${url}（${r.status}）`);
      return r.arrayBuffer();
    });
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await tmp.decodeAudioData(buf);
    tmp.close?.();

    // 重取樣到 24000，因為 playChunk 是照 24000 建 buffer 的
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * RATE), RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const f32 = rendered.getChannelData(0);

    const out = [];
    for (let i = 0; i < f32.length; i += CHUNK) {
      const slice = f32.subarray(i, Math.min(i + CHUNK, f32.length));
      const int16 = new Int16Array(slice.length);
      for (let k = 0; k < slice.length; k++) {
        const v = Math.max(-1, Math.min(1, slice[k]));
        int16[k] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      let bin = '';
      const bytes = new Uint8Array(int16.buffer);
      for (let k = 0; k < bytes.length; k += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
      }
      out.push(btoa(bin));
    }
    const res = { chunks: out, duration: rendered.duration };
    audioCache.set(url, res);
    return res;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 假的 WebSocket ──────────────────────────────────────────────────
  const RealWS = window.WebSocket;

  function DemoWS(url, protocols) {
    if (!/\/ws\/speaking/.test(String(url))) return new RealWS(url, protocols);
    if (!(this instanceof DemoWS)) return new DemoWS(url, protocols);

    this.url = url;
    this.readyState = 0;
    this.protocol = Array.isArray(protocols) ? protocols[0] : (protocols || '');
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this._stopped = false;
    this._skip = false;

    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({ type: 'open' });
      this._run().catch((e) => {
        console.error('[demo] 口說重播失敗', e);
        this._emit({ type: 'fatal', message: '示範對話載入失敗：' + e.message });
      });
    }, 120);
  }

  DemoWS.prototype._emit = function (obj) {
    if (this._stopped) return;
    this.onmessage?.({ data: JSON.stringify(obj) });
  };

  DemoWS.prototype._wait = async function (ms) {
    // 訪客按了「跳過」就把等待壓縮掉，不用真的坐等兩分鐘
    const step = 50;
    let left = this._skip ? Math.min(ms, 150) : ms;
    while (left > 0 && !this._stopped) {
      await sleep(Math.min(step, left));
      left -= step;
      if (this._skip) left = Math.min(left, 150);
    }
  };

  /* 畫面上原本寫著「直接開口說話即可，不用按任何按鈕」。在示範站那是假的
     —— 沒有人在聽。訪客對著螢幕講話卻毫無反應，會覺得系統壞了，
     而壞掉的其實是這句話。所以換掉它。 */
  function fixHint() {
    const orb = document.querySelector('#sp-orb');
    if (!orb) return false;
    const p = [...orb.parentElement.querySelectorAll('p.small')]
      .find((x) => x.textContent.includes('直接開口說話'));
    if (!p) return false;
    p.textContent = '這是錄好的示範對話 —— 考官會照腳本進行，不會用到你的麥克風。'
      + '正式站在這裡是跟 AI 考官全雙工即時對話。';
    p.style.opacity = '.85';
    return true;
  }

  DemoWS.prototype._run = async function () {
    this._emit({ type: 'ready', examiner: { showCueCard: true, showLiveScore: true, showTranscript: true } });
    // 畫面是收到 ready 之後才畫的，等一拍再改；改不到就再試幾次
    for (let i = 0; i < 8 && !fixHint(); i++) await sleep(250);

    for (const [i, t] of SCRIPT.turns.entries()) {
      if (this._stopped) return;
      await this._wait(t.at || 0);
      if (this._stopped) return;

      if (t.phase) this._emit({ type: 'phase', phase: t.phase, cueCard: t.cue || null });
      if (t.cue) this._emit({ type: 'phase', phase: 'part2_instruct', cueCard: t.cue });
      if (t.prep) this._emit({ type: 'prep', seconds: t.prep, cueCard: null });
      if (t.talk) this._emit({ type: 'talk', seconds: t.talk });
      if (t.score) this._emit({ type: 'live_score', band: t.score.band, criteria: { FC: t.score.FC, LR: t.score.LR, GRA: t.score.GRA, PRO: t.score.PRO } });

      if (t.ex) {
        this._emit({ type: 'examiner', text: t.ex });
        const url = `demo/audio/speaking/ex-${String(i).padStart(2, '0')}.mp3`;
        try {
          const { chunks, duration } = await pcmChunks(url);
          for (const delta of chunks) {
            if (this._stopped) return;
            this._emit({ type: 'audio', delta });
            // 給測試看的：確認聲音真的有走進前端的音訊管線，
            // 而不是只有逐字稿在動
            window.__demoAudioChunks = (window.__demoAudioChunks || 0) + 1;
          }
          // 前端是照 playHead 排程播放的，所以這裡等的是「聲音播完」
          await this._wait(this._skip ? 200 : duration * 1000);
        } catch (e) {
          console.warn('[demo] 這句沒有語音，只顯示文字：', url, e.message);
          await this._wait(Math.min(6000, t.ex.length * 55));
        }
        this._emit({ type: 'examiner_done' });
      }

      if (t.ca) {
        this._emit({ type: 'candidate_speaking', on: true });
        await this._wait(this._skip ? 150 : Math.min(9000, t.ca.length * 42));
        this._emit({ type: 'candidate', text: t.ca });
        this._emit({ type: 'candidate_speaking', on: false });
      }

      if (t.finish) {
        this._emit({ type: 'finishing' });
        await this._wait(1800);
        this._emit({
          type: 'final_score',
          band: SCRIPT.final.band,
          criteria: SCRIPT.final.criteria,
          feedback: SCRIPT.final.feedback,
          summary: SCRIPT.final.summary,
        });
        await this._wait(300);
        this._emit({ type: 'done' });
        this.readyState = 3;
        this.onclose?.({ code: 1000, reason: 'demo 結束', wasClean: true });
        return;
      }
    }
  };

  DemoWS.prototype.send = function (raw) {
    let m = null;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'skip') { this._skip = true; return; }
    if (m.type === 'nudge') {
      this._emit({ type: 'nudged', ignored: true, message: '這是錄好的示範對話，考官照腳本進行' });
      return;
    }
    if (m.type === 'finish') { this._skip = true; return; }
    // mic / device_permission：示範站不需要處理
  };

  DemoWS.prototype.close = function () {
    this._stopped = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: 'closed', wasClean: true });
  };

  DemoWS.prototype.addEventListener = function (ev, fn) { this['on' + ev] = fn; };
  DemoWS.prototype.removeEventListener = function (ev) { this['on' + ev] = null; };

  DemoWS.CONNECTING = 0; DemoWS.OPEN = 1; DemoWS.CLOSING = 2; DemoWS.CLOSED = 3;
  window.WebSocket = DemoWS;
})();
