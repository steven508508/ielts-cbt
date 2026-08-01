'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');

module.exports = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'),
  SAMPLES_DIR: path.join(ROOT, 'samples'),

  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  tokenTtl: process.env.TOKEN_TTL || '12h',
  // 在 Nginx / Caddy 後面時設 1，才讀得到真實來源 IP（速率限制會用到）
  trustProxy: process.env.TRUST_PROXY || 0,
  isProduction: process.env.NODE_ENV === 'production',

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ielts_cbt',
    charset: 'utf8mb4',
    connectionLimit: Number(process.env.DB_POOL || 10),
    waitForConnections: true,
    // 一定要設 queueLimit。預設 0 = 無上限排隊，連線用完之後
    // 每一個請求都會「永遠」等下去 —— 沒有錯誤、沒有日誌，
    // 連 /api/health 也一起卡住，Docker 因此永遠不會判定要重啟。
    queueLimit: Number(process.env.DB_QUEUE_LIMIT || 60),
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT || 10_000),
    enableKeepAlive: true,
    keepAliveInitialDelay: 30_000,
    multipleStatements: false,
    dateStrings: true,
  },

  // Cloudflare Turnstile 人機驗證（也可以之後在網頁「系統設定」填）
  turnstileDefaults: {
    ...(process.env.TURNSTILE_SITE_KEY ? { siteKey: process.env.TURNSTILE_SITE_KEY } : {}),
    ...(process.env.TURNSTILE_SECRET_KEY ? { secretKey: process.env.TURNSTILE_SECRET_KEY } : {}),
    ...(process.env.TURNSTILE_ENABLED ? { enabled: process.env.TURNSTILE_ENABLED === '1' } : {}),
  },

  bootstrapAdmin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin1234',
    name: process.env.ADMIN_NAME || 'Administrator',
  },

  // .env 提供的 AI 預設值；網頁「系統設定」存進 DB 後會覆蓋這裡
  aiDefaults: {
    provider: process.env.AI_PROVIDER || 'anthropic',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
    customProtocol: process.env.CUSTOM_PROTOCOL || 'openai',
    customApiKey: process.env.CUSTOM_API_KEY || '',
    customBaseUrl: process.env.CUSTOM_BASE_URL || '',
    customModel: process.env.CUSTOM_MODEL || '',
    sttProvider: process.env.STT_PROVIDER || 'openai',
    sttModel: process.env.STT_MODEL || 'whisper-1',
    ttsProvider: process.env.TTS_PROVIDER || 'openai',
    ttsModel: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
    ttsVoice: process.env.TTS_VOICE || 'alloy',
    // 口說即時語音對話用的 Realtime 模型（需 OpenAI 相容的 /realtime WebSocket 端點）
    realtimeModel: process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview',
  },
};
