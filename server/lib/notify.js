'use strict';
/**
 * 通知。
 *
 * 站內通知一定會送到（不需要任何設定）；Email 是選用的，
 * 沒設定 SMTP 就只是不寄，其他一切照常。
 *
 * 刻意不引入 nodemailer —— 這個專案的相依套件很少，
 * 為了寄信多一整包依賴不划算。直接講 SMTP 就好，
 * 需要的功能只有 STARTTLS + AUTH LOGIN + 一封純文字信。
 */
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');
const db = require('../db');

const SMTP_KEY = 'smtp';

const SMTP_DEFAULTS = {
  enabled: false,
  host: '',
  port: 587,
  secure: false,        // true = 一開始就 TLS（465）；false = 先明文再 STARTTLS（587）
  user: '',
  pass: '',
  from: '',
  fromName: 'IELTS 模擬考',
};

let cache = null;
let cacheAt = 0;

async function getSmtp(force = false) {
  if (!force && cache && Date.now() - cacheAt < 15000) return cache;
  let stored = {};
  try {
    const row = await db.one('SELECT v FROM settings WHERE k = ?', [SMTP_KEY]);
    if (row?.v) stored = JSON.parse(row.v) || {};
  } catch { /* 資料表還沒建好 */ }
  cache = { ...SMTP_DEFAULTS, ...stored };
  cacheAt = Date.now();
  return cache;
}

async function saveSmtp(patch) {
  const cur = await getSmtp(true);
  const next = { ...cur, ...patch };
  next.enabled = !!next.enabled;
  next.secure = !!next.secure;
  next.port = Number(next.port) || 587;
  for (const k of ['host', 'user', 'pass', 'from', 'fromName']) next[k] = String(next[k] || '').trim();
  await db.setSetting(SMTP_KEY, next);
  cache = next; cacheAt = Date.now();
  return next;
}

function maskSmtp(c) {
  return {
    enabled: !!c.enabled, host: c.host, port: c.port, secure: !!c.secure,
    user: c.user, pass: c.pass ? '••••••' : '', hasPass: !!c.pass,
    from: c.from, fromName: c.fromName,
    active: !!(c.enabled && c.host && c.from),
  };
}

// ── 站內通知 ─────────────────────────────────────────────────
/**
 * 送通知給一批使用者。
 * @param {number[]} userIds
 * @param {{type:string,title:string,body?:string,link?:string,email?:boolean}} n
 */
async function push(userIds, n) {
  const ids = [...new Set((userIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  if (!ids.length) return { sent: 0 };

  // 一次一批寫進去，數量大時不要組成超長 SQL
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const values = chunk.map(() => '(?,?,?,?,?)').join(',');
    const params = [];
    for (const uid of chunk) {
      params.push(uid, n.type, String(n.title).slice(0, 200),
        n.body ? String(n.body).slice(0, 500) : null,
        n.link ? String(n.link).slice(0, 200) : null);
    }
    await db.exec(
      `INSERT INTO notifications (user_id, type, title, body, link) VALUES ${values}`, params
    ).catch((e) => console.warn('[notify] 寫入失敗：', e.message));
  }

  // Email 是加值，寄不出去不能影響主流程
  if (n.email !== false) {
    mailTo(ids, n).catch((e) => console.warn('[notify] 寄信失敗：', e.message));
  }
  return { sent: ids.length };
}

async function listFor(userId, { limit = 30, unreadOnly = false } = {}) {
  const rows = await db.query(
    `SELECT id, type, title, body, link, read_at, created_at
       FROM notifications
      WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''}
      ORDER BY id DESC LIMIT ${Math.min(100, Math.max(1, Number(limit) || 30))}`,
    [userId]
  );
  const un = await db.one(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId]);
  return { items: rows, unread: Number(un?.n || 0) };
}

async function markRead(userId, ids = null) {
  if (ids && ids.length) {
    const clean = ids.map(Number).filter(Number.isInteger).slice(0, 200);
    if (!clean.length) return 0;
    const r = await db.exec(
      `UPDATE notifications SET read_at = NOW()
        WHERE user_id = ? AND read_at IS NULL AND id IN (${clean.map(() => '?').join(',')})`,
      [userId, ...clean]
    );
    return r?.affectedRows || 0;
  }
  const r = await db.exec(
    'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [userId]);
  return r?.affectedRows || 0;
}

/** 清掉太舊的已讀通知 */
async function cleanup(days = 60) {
  const r = await db.exec(
    'DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
    [Number(days) || 60]
  );
  return r?.affectedRows || 0;
}

// ── Email ────────────────────────────────────────────────────
/** RFC 2047：中文主旨要編碼，不然大部分收件軟體會顯示亂碼 */
function encodeHeader(s) {
  const str = String(s || '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/** 組一封純文字信。Date 與 Message-ID 一定要有，不然很多收件端直接判垃圾信。 */
function buildMessage({ from, fromName, to, subject, text, date, id }) {
  return [
    `From: ${fromName ? `${encodeHeader(fromName)} ` : ''}<${from}>`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${(date || new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id || crypto.randomUUID()}@${from.split('@')[1] || 'localhost'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text).replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n');
}

/**
 * 極簡 SMTP 客戶端：連線 → EHLO →（STARTTLS → EHLO）→ AUTH LOGIN → MAIL/RCPT/DATA。
 *
 * 幾個踩過的雷：
 *  - EHLO 一定要在 STARTTLS／AUTH 之前，少了就是 503 EHLO/HELO first。
 *  - 回應可能是多行（250-SIZE / 250-STARTTLS / 250 AUTH…），
 *    只有「三位數字後面接空白」的那一行才代表這則回應講完了；
 *    照著換行判斷會在多行回應中間就往下走。
 *  - 升級 TLS 前要把舊 socket 的 data 監聽拆掉，否則同一份資料會被讀兩次。
 */
function smtpSend({ host, port, secure, user, pass, from, fromName, to, subject, text }, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!host) return reject(new Error('沒有設定 SMTP 主機'));
    const rcpts = (Array.isArray(to) ? to : [to]).filter(Boolean);
    if (!rcpts.length) return reject(new Error('沒有收件者'));

    let socket = secure
      ? tls.connect({ host, port: port || 465, servername: host })
      : net.connect({ host, port: port || 587 });

    let buf = '';
    let waiter = null;
    let done = false;

    const settle = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* 已經斷了 */ }
      err ? reject(err) : resolve(true);
    };
    const timer = setTimeout(
      () => settle(new Error(`SMTP 在 ${timeout / 1000} 秒內沒有回應`)), timeout);

    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const cut = buf.lastIndexOf('\n');
      if (cut < 0) return;
      const whole = buf.slice(0, cut + 1);
      const lines = whole.split(/\r?\n/).filter((l) => l !== '');
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return;      // 多行回應還沒講完
      buf = buf.slice(cut + 1);
      const w = waiter; waiter = null;
      if (w) w({ code: Number(last.slice(0, 3)), text: whole.trim(), last });
    };
    const onError = (e) => settle(e);
    const attach = (s) => { s.on('data', onData); s.on('error', onError); };
    attach(socket);

    const reply = () => new Promise((res) => { waiter = res; });
    const say = async (line) => {
      socket.write(`${line}\r\n`);
      const r = await reply();
      if (r.code >= 400) throw new Error(`SMTP ${r.last}`);
      return r;
    };

    // EHLO 要報自己的網域；用寄件人的網域比報對方主機名合理
    const me = String(from || '').split('@')[1] || os.hostname() || 'localhost';

    (async () => {
      const greet = await reply();
      if (greet.code >= 400) throw new Error(`SMTP ${greet.last}`);

      let ehlo = await say(`EHLO ${me}`);

      if (!secure && /STARTTLS/i.test(ehlo.text)) {
        await say('STARTTLS');
        const plain = socket;
        plain.removeListener('data', onData);
        plain.removeListener('error', onError);
        socket = await new Promise((res, rej) => {
          const up = tls.connect({ socket: plain, servername: host }, () => res(up));
          up.once('error', rej);
        });
        attach(socket);
        ehlo = await say(`EHLO ${me}`);       // 加密後要重新自我介紹
      }

      if (user) {
        await say('AUTH LOGIN');
        await say(b64(user));
        await say(b64(pass));
      }

      await say(`MAIL FROM:<${from}>`);
      for (const r of rcpts) await say(`RCPT TO:<${r}>`);
      await say('DATA');
      await say(`${buildMessage({ from, fromName, to: rcpts, subject, text })}\r\n.`);
      try { await say('QUIT'); } catch { /* 有些伺服器直接斷線，信已經收下了 */ }
      settle(null);
    })().catch(settle);
  });
}

/** 寄給一批使用者（每個人一封，收件者不會看到彼此） */
async function mailTo(userIds, n) {
  const cfg = await getSmtp();
  if (!cfg.enabled || !cfg.host || !cfg.from) return { skipped: true };

  const rows = await db.query(
    `SELECT email, name FROM users WHERE id IN (${userIds.map(() => '?').join(',')}) AND email IS NOT NULL AND email <> ''`,
    userIds
  );
  if (!rows.length) return { sent: 0 };

  let sent = 0;
  for (const u of rows) {
    try {
      await smtpSend({
        host: cfg.host, port: cfg.port, secure: cfg.secure,
        user: cfg.user, pass: cfg.pass, from: cfg.from, fromName: cfg.fromName,
        to: [u.email],
        subject: n.title,
        text: `${u.name || ''}你好：\n\n${n.title}\n${n.body || ''}\n\n${n.link ? `請到系統查看：${n.link}\n\n` : ''}—— IELTS 模擬考系統`,
      });
      sent += 1;
    } catch (e) {
      console.warn(`[notify] 寄給 ${u.email} 失敗：`, e.message);
    }
  }
  return { sent };
}

module.exports = {
  push, listFor, markRead, cleanup,
  getSmtp, saveSmtp, maskSmtp, smtpSend, mailTo, encodeHeader, buildMessage, SMTP_DEFAULTS,
};
