'use strict';
/**
 * Cloudflare Turnstile 人機驗證。
 *
 * 設計原則：
 *  · 預設關閉。沒設定金鑰時完全不影響原本的登入流程。
 *  · Site Key 是公開的（要放進網頁），Secret Key 只留在伺服器，前端只拿得到遮罩字串。
 *  · Cloudflare 連不上時預設「放行」——校內考試中被鎖在門外的風險，
 *    比擋不住機器人嚴重；登入本來就還有速率限制擋暴力破解。
 *    要嚴格的話可以把 failOpen 關掉。
 */
const db = require('../db');
const config = require('../config');

const KEY = 'turnstile';
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const DEFAULTS = {
  enabled: false,
  siteKey: '',
  secretKey: '',
  failOpen: true,          // Cloudflare 連不上或回 5xx 時是否放行
  protectLogin: true,      // 目前只有登入需要驗證，保留擴充空間
};

let cache = null;
let cacheAt = 0;

async function getConfig(force = false) {
  if (!force && cache && Date.now() - cacheAt < 15000) return cache;
  let stored = {};
  try {
    const row = await db.one('SELECT v FROM settings WHERE k = ?', [KEY]);
    if (row && row.v) stored = JSON.parse(row.v) || {};
  } catch { /* 資料表還沒建好時忽略 */ }
  cache = { ...DEFAULTS, ...config.turnstileDefaults, ...stored };
  // 緊急關閉開關：驗證框壞掉、所有人都登不進來時，
  // 在 .env 加一行 TURNSTILE_DISABLED=1 再重啟即可，不必動資料庫。
  if (process.env.TURNSTILE_DISABLED === '1') cache = { ...cache, enabled: false, forcedOff: true };
  cacheAt = Date.now();
  return cache;
}

async function saveConfig(patch) {
  const current = await getConfig(true);
  const next = { ...current, ...patch };
  next.enabled = !!next.enabled;
  next.failOpen = !!next.failOpen;
  next.siteKey = String(next.siteKey || '').trim();
  next.secretKey = String(next.secretKey || '').trim();
  await db.setSetting(KEY, next);
  cache = next;
  cacheAt = Date.now();
  return next;
}

/** 目前是否真的會擋（有開、而且兩把金鑰都填了） */
async function isActive() {
  const c = await getConfig();
  return !!(c.enabled && c.siteKey && c.secretKey);
}

/** 給登入頁用的公開資訊，絕對不含 Secret Key */
async function publicConfig() {
  const c = await getConfig();
  const active = !!(c.enabled && c.siteKey && c.secretKey);
  return { enabled: active, siteKey: active ? c.siteKey : '' };
}

/**
 * 驗證前端送上來的 token。
 * @returns {{ok:boolean, skipped?:boolean, reason?:string, codes?:string[]}}
 */
async function verify(token, remoteIp) {
  const c = await getConfig();
  if (!c.enabled || !c.siteKey || !c.secretKey) return { ok: true, skipped: true };

  if (!token) return { ok: false, reason: '請先完成人機驗證', codes: ['missing-input-response'] };

  const body = new URLSearchParams({ secret: c.secretKey, response: String(token) });
  if (remoteIp) body.set('remoteip', remoteIp);

  let data;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    console.warn('[turnstile] 無法連線到 Cloudflare：', e.message);
    return c.failOpen
      ? { ok: true, skipped: true, reason: `驗證服務暫時無法連線（已放行）：${e.message}` }
      : { ok: false, reason: '人機驗證服務暫時無法連線，請稍後再試' };
  }

  if (data.success) return { ok: true };

  const codes = data['error-codes'] || [];
  const friendly = {
    'missing-input-response': '請先完成人機驗證',
    'invalid-input-response': '人機驗證失敗，請重新驗證一次',
    'timeout-or-duplicate': '驗證已逾時或重複使用，請重新驗證',
    'invalid-input-secret': '伺服器的 Turnstile Secret Key 設定有誤，請通知管理員',
    'missing-input-secret': '伺服器尚未設定 Turnstile Secret Key，請通知管理員',
    'bad-request': '驗證請求格式錯誤',
    'internal-error': '驗證服務發生錯誤，請重試',
  };
  const reason = codes.map((x) => friendly[x]).find(Boolean) || '人機驗證失敗，請重新驗證一次';
  return { ok: false, reason, codes };
}

/** 給後台顯示用（遮蔽 Secret Key） */
function maskConfig(c) {
  const s = c.secretKey || '';
  return {
    enabled: !!c.enabled,
    siteKey: c.siteKey || '',
    secretKey: s ? `${s.slice(0, 6)}••••${s.slice(-4)}` : '',
    hasSecret: !!s,
    failOpen: c.failOpen !== false,
    protectLogin: c.protectLogin !== false,
    active: !!(c.enabled && c.siteKey && s),
    forcedOff: !!c.forcedOff,
  };
}

module.exports = { getConfig, saveConfig, publicConfig, isActive, verify, maskConfig, DEFAULTS, VERIFY_URL };
