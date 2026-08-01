'use strict';
/**
 * AI 供應商抽象層。
 * 同時支援 Anthropic（Claude）、OpenAI，以及任何「OpenAI 相容」或
 * 「Anthropic 相容」的自訂端點（Azure、DeepSeek、Groq、Ollama、one-api、
 * new-api、自架的 LiteLLM…）。
 *
 * 對外只有三個能力：
 *   chat({system, user, json})       → 文字 / JSON
 *   transcribe(buffer, filename)     → 語音轉文字（STT）
 *   speak(text)                      → 文字轉語音（TTS），回傳 audio Buffer
 */
const db = require('../db');
const config = require('../config');

const SETTING_KEY = 'ai';

let cache = null;
let cacheAt = 0;

/** 合併 .env 預設值與資料庫設定 */
async function getConfig(force = false) {
  if (!force && cache && Date.now() - cacheAt < 15000) return cache;
  let stored = {};
  try {
    const row = await db.one('SELECT v FROM settings WHERE k = ?', [SETTING_KEY]);
    if (row && row.v) stored = JSON.parse(row.v) || {};
  } catch { /* 資料表還沒建好時忽略 */ }
  cache = { ...config.aiDefaults, ...stored };
  cacheAt = Date.now();
  return cache;
}

async function saveConfig(patch) {
  const current = await getConfig(true);
  const next = { ...current, ...patch };
  await db.setSetting(SETTING_KEY, next);
  cache = next;
  cacheAt = Date.now();
  return next;
}

/** 把設定攤成「這一次呼叫要用哪個端點」 */
function resolve(cfg, role = 'chat') {
  const providerFor = {
    chat: cfg.provider,
    stt: cfg.sttProvider || cfg.provider,
    tts: cfg.ttsProvider || cfg.provider,
  }[role];

  if (providerFor === 'anthropic') {
    return {
      provider: 'anthropic', protocol: 'anthropic',
      baseUrl: (cfg.anthropicBaseUrl || 'https://api.anthropic.com').replace(/\/+$/, ''),
      apiKey: cfg.anthropicApiKey,
      model: cfg.anthropicModel || 'claude-sonnet-4-5',
    };
  }
  if (providerFor === 'openai') {
    return {
      provider: 'openai', protocol: 'openai',
      baseUrl: (cfg.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: cfg.openaiApiKey,
      model: role === 'stt' ? (cfg.sttModel || 'whisper-1')
        : role === 'tts' ? (cfg.ttsModel || 'gpt-4o-mini-tts')
        : (cfg.openaiModel || 'gpt-4o'),
    };
  }
  // custom
  return {
    provider: 'custom',
    protocol: cfg.customProtocol === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: (cfg.customBaseUrl || '').replace(/\/+$/, ''),
    apiKey: cfg.customApiKey,
    model: role === 'stt' ? (cfg.sttModel || cfg.customModel)
      : role === 'tts' ? (cfg.ttsModel || cfg.customModel)
      : (cfg.customModel || ''),
  };
}

async function logCall(purpose, ep, ok, ms, error, userId) {
  try {
    await db.exec(
      'INSERT INTO ai_logs (purpose, provider, model, ok, ms, error, user_id) VALUES (?,?,?,?,?,?,?)',
      [purpose, ep.provider, ep.model, ok ? 1 : 0, ms, error ? String(error).slice(0, 800) : null, userId || null]
    );
  } catch { /* 紀錄失敗不影響主流程 */ }
}

function stripCodeFence(t) {
  const s = String(t || '').trim();
  const m = s.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s;
}

/** 從模型回覆中盡力挖出 JSON */
function parseJson(text) {
  const cleaned = stripCodeFence(text);
  try { return JSON.parse(cleaned); } catch { /* 繼續嘗試 */ }
  const start = cleaned.search(/[[{]/);
  if (start >= 0) {
    for (let end = cleaned.length; end > start; end--) {
      const slice = cleaned.slice(start, end);
      const last = slice[slice.length - 1];
      if (last !== '}' && last !== ']') continue;
      try { return JSON.parse(slice); } catch { /* 再往前縮 */ }
    }
  }
  throw new Error('AI 回覆不是有效的 JSON：' + cleaned.slice(0, 300));
}

const DEFAULT_TIMEOUT = Number(process.env.AI_TIMEOUT_MS || 180000);

async function fetchWithTimeout(url, options, ms = DEFAULT_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    // Node 的 abort 只會丟出「This operation was aborted」，對老師來說毫無意義
    if (e?.name === 'AbortError' || /operation was aborted/i.test(e?.message || '')) {
      const err = new Error(`AI 端點在 ${Math.round(ms / 1000)} 秒內沒有回應（逾時）`);
      err.code = 'AI_TIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 把各種底層錯誤翻成老師看得懂、而且知道下一步該做什麼的訊息 */
function friendlyError(e) {
  const m = String(e?.message || e || '');
  if (e?.friendly) return m;          // 已經翻譯過的不要再包一層
  if (e?.code === 'AI_TIMEOUT' || /operation was aborted|aborted/i.test(m))
    return `${m || 'AI 端點逾時'}。試卷太長時很常見——可以改用「單一題組」分次產生，或在 .env 調高 AI_TIMEOUT_MS。`;
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(m))
    return `連不到 AI 端點（${m}）。檢查「系統設定 → AI」的 Base URL，以及伺服器有沒有對外網路。`;
  if (/\b401\b|invalid.*api.?key|authentication/i.test(m))
    return 'API Key 無效或已失效，請到「系統設定 → AI」重新填寫。';
  if (/\b429\b|rate.?limit|quota|insufficient/i.test(m))
    return 'AI 供應商回報額度不足或請求太頻繁（429）。等幾分鐘再試，或檢查帳戶餘額。';
  if (/max_tokens|context length|too many tokens/i.test(m))
    return `模型的輸出上限不夠（${m}）。換一個輸出長度較大的模型，或改用「單一題組」分次產生。`;
  if (/不是有效的 JSON/.test(m))
    return `${m}\n（模型沒有回傳乾淨的 JSON。換能力較強的模型通常就會好。）`;
  return m;
}

// ── 文字生成 ───────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {string} o.system  系統指示
 * @param {string} o.user    使用者訊息
 * @param {boolean} o.json   是否要求回傳 JSON
 * @param {number} o.maxTokens
 */
async function chat({ system, user, json = false, maxTokens = 8000, temperature = 0.7, purpose = 'chat', userId = null }) {
  const cfg = await getConfig();
  const ep = resolve(cfg, 'chat');
  const configError = (msg) => { const e = new Error(msg); e.code = 'AI_NOT_CONFIGURED'; e.friendly = true; return e; };
  if (!ep.apiKey && !/localhost|127\.0\.0\.1/.test(ep.baseUrl))
    throw configError(`尚未設定 ${ep.provider} 的 API Key，請到「系統設定 → AI」填寫`);
  if (!ep.baseUrl) throw configError('尚未設定 AI 端點網址');
  if (!ep.model) throw configError('尚未設定 AI 模型名稱');

  const started = Date.now();
  const sys = json ? `${system}\n\nIMPORTANT: Reply with valid JSON only. No prose, no markdown code fences.` : system;

  try {
    let text;
    if (ep.protocol === 'anthropic') {
      const res = await fetchWithTimeout(`${ep.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ep.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ep.model,
          max_tokens: maxTokens,
          temperature,
          system: sys,
          messages: [{ role: 'user', content: user }],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    } else {
      const body = {
        model: ep.model,
        temperature,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      };
      if (json) body.response_format = { type: 'json_object' };
      const res = await fetchWithTimeout(`${ep.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      text = data?.choices?.[0]?.message?.content || '';
    }
    await logCall(purpose, ep, true, Date.now() - started, null, userId);
    return json ? parseJson(text) : text;
  } catch (err) {
    await logCall(purpose, ep, false, Date.now() - started, err.message, userId);
    throw err;
  }
}

// ── 語音轉文字 ─────────────────────────────────────────────────
async function transcribe(buffer, filename = 'audio.webm', { language = 'en', userId = null } = {}) {
  const cfg = await getConfig();
  const ep = resolve(cfg, 'stt');
  if (ep.protocol === 'anthropic')
    throw new Error('Anthropic 沒有語音轉文字服務，請在「系統設定 → 語音」把 STT 指定為 OpenAI 或自訂端點');
  if (!ep.baseUrl) throw new Error('尚未設定語音轉文字端點');

  const started = Date.now();
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer]), filename);
    form.append('model', ep.model || 'whisper-1');
    if (language) form.append('language', language);
    const res = await fetchWithTimeout(`${ep.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ep.apiKey}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    await logCall('stt', ep, true, Date.now() - started, null, userId);
    return data.text || '';
  } catch (err) {
    await logCall('stt', ep, false, Date.now() - started, err.message, userId);
    throw err;
  }
}

// ── 文字轉語音 ─────────────────────────────────────────────────
async function speak(text, { voice, userId = null } = {}) {
  const cfg = await getConfig();
  const ep = resolve(cfg, 'tts');
  if (ep.protocol === 'anthropic')
    throw new Error('Anthropic 沒有語音合成服務，請把 TTS 指定為 OpenAI 或自訂端點（也可改用瀏覽器內建語音）');
  if (!ep.baseUrl) throw new Error('尚未設定語音合成端點');

  const started = Date.now();
  try {
    const res = await fetchWithTimeout(`${ep.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({
        model: ep.model || 'gpt-4o-mini-tts',
        voice: voice || cfg.ttsVoice || 'alloy',
        input: text,
        response_format: 'mp3',
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(t || `HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await logCall('tts', ep, true, Date.now() - started, null, userId);
    return buf;
  } catch (err) {
    await logCall('tts', ep, false, Date.now() - started, err.message, userId);
    throw err;
  }
}

/** 測試連線是否可用 */
async function testConnection(role = 'chat') {
  const cfg = await getConfig(true);
  const ep = resolve(cfg, role);
  if (role === 'chat') {
    const t = await chat({
      system: 'You are a connectivity test.',
      user: 'Reply with exactly: OK',
      maxTokens: 16, temperature: 0, purpose: 'test',
    });
    return { ok: true, provider: ep.provider, model: ep.model, reply: String(t).trim().slice(0, 40) };
  }
  if (role === 'tts') {
    const buf = await speak('This is a connection test.');
    return { ok: true, provider: ep.provider, model: ep.model, bytes: buf.length };
  }
  return { ok: false, message: 'STT 請直接在口說模組中測試' };
}

/** 給前端看的設定（金鑰遮蔽） */
function maskConfig(cfg) {
  const mask = (k) => (k ? `${String(k).slice(0, 6)}••••${String(k).slice(-4)}` : '');
  return {
    ...cfg,
    anthropicApiKey: mask(cfg.anthropicApiKey),
    openaiApiKey: mask(cfg.openaiApiKey),
    customApiKey: mask(cfg.customApiKey),
    _hasAnthropicKey: !!cfg.anthropicApiKey,
    _hasOpenaiKey: !!cfg.openaiApiKey,
    _hasCustomKey: !!cfg.customApiKey,
  };
}

module.exports = { getConfig, saveConfig, chat, transcribe, speak, testConnection, maskConfig, parseJson, resolve, friendlyError, DEFAULT_TIMEOUT };
