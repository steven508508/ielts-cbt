'use strict';
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const config = require('./config');

let pool = null;

function getPool() {
  if (!pool) pool = mysql.createPool(config.db);
  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/** 執行 SQL 但不使用 prepared statement（DDL 用） */
async function raw(sql) {
  const conn = await getPool().getConnection();
  try {
    const [rows] = await conn.query(sql);
    return rows;
  } finally {
    conn.release();
  }
}

async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function insert(sql, params = []) {
  const [res] = await getPool().execute(sql, params);
  return res.insertId;
}

async function exec(sql, params = []) {
  const [res] = await getPool().execute(sql, params);
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等資料庫可以連線（容器啟動時 MySQL 常常比 App 慢） */
async function waitForDb({
  retries = Number(process.env.DB_WAIT_RETRIES || 45),
  delayMs = Number(process.env.DB_WAIT_DELAY_MS || 2000),
} = {}) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const conn = await mysql.createConnection({
        host: config.db.host, port: config.db.port,
        user: config.db.user, password: config.db.password,
        connectTimeout: 5000,
      });
      await conn.query('SELECT 1');
      return conn;
    } catch (e) {
      lastErr = e;
      if (i === 1 || i % 5 === 0) console.log(`[db] 等待資料庫… (${i}/${retries}) ${e.code || e.message}`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

/** 若資料庫不存在則建立，再建立所有資料表 */
async function initSchema() {
  // 先用不指定 database 的連線把資料庫建起來
  const boot = await waitForDb();
  await boot.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` ` +
      `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await boot.end();

  // 先把註解整行拿掉，再依分號切成一句一句執行
  const sqlText = fs
    .readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');

  const statements = sqlText
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const stmt of statements) await raw(stmt);
  await migrate();
}

/** 舊版資料庫升級：只在欄位不存在時才新增，可重複執行 */
async function ensureColumn(table, column, definition) {
  const row = await one(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [config.db.database, table, column]
  );
  if (Number(row?.n || 0) > 0) return false;
  await raw(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  return true;
}

async function migrate() {
  const added = [];
  const steps = [
    ['media', 'folder', 'VARCHAR(120) NULL'],
    ['media', 'tags', 'VARCHAR(255) NULL'],
    ['tests', 'archived', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['attempts', 'archived', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['attempts', 'speaking_mode', "VARCHAR(20) NOT NULL DEFAULT 'turn'"],
    ['assignments', 'speaking_realtime', 'TINYINT(1) NOT NULL DEFAULT 1'],
    // v2.1：老師可自訂的考試規則
    ['assignments', 'duration_overrides', 'TEXT NULL'],
    ['assignments', 'extra_time_pct', 'INT NOT NULL DEFAULT 0'],
    ['assignments', 'proctoring', 'TEXT NULL'],
    ['assignments', 'break_policy', "VARCHAR(20) NOT NULL DEFAULT 'flexible'"],
    ['assignments', 'break_seconds', 'INT NOT NULL DEFAULT 0'],
  ];
  for (const [t, c, d] of steps) {
    try { if (await ensureColumn(t, c, d)) added.push(`${t}.${c}`); }
    catch (e) { console.warn(`[migrate] ${t}.${c}: ${e.message}`); }
  }
  if (added.length) console.log('[migrate] 新增欄位：', added.join(', '));
  return added;
}

/** 第一次啟動時建立管理員帳號 */
async function bootstrapAdmin() {
  const existing = await one('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
  if (existing) return null;
  const { username, password, name } = config.bootstrapAdmin;
  const hash = await bcrypt.hash(password, 10);
  await insert(
    'INSERT INTO users (username, password_hash, name, role) VALUES (?,?,?,?)',
    [username, hash, name, 'admin']
  );
  return username;
}

// ── 設定表：讀 / 寫 ────────────────────────────────────
async function getSettings() {
  const rows = await query('SELECT k, v FROM settings');
  const out = {};
  for (const r of rows) {
    try {
      out[r.k] = JSON.parse(r.v);
    } catch {
      out[r.k] = r.v;
    }
  }
  return out;
}

async function setSetting(k, v) {
  const val = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v ?? null);
  await exec('INSERT INTO settings (k, v) VALUES (?,?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, val]);
}

async function close() {
  if (pool) { await pool.end().catch(() => {}); pool = null; }
}

module.exports = {
  getPool, query, one, insert, exec, raw, close, waitForDb,
  initSchema, migrate, ensureColumn, bootstrapAdmin, getSettings, setSetting,
};
