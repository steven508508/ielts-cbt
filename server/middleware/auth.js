'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

/** 檔案存取用的 cookie 名稱。<audio src> / <img src> 沒辦法帶 Authorization 標頭。 */
const FILE_COOKIE = 'ielts_file';

function sign(user) {
  return jwt.sign(
    /* tv = token version。改密碼時 users.token_version 會 +1，舊 token 立刻失效。
       以前只要密碼外流過，改密碼也踢不掉對方 —— 那把 token 還有效 12 小時，
       而介面上「重設密碼」看起來就是處置動作。唯一真的有效的是停用帳號。 */
    { uid: user.id, username: user.username, role: user.role, name: user.name, tv: Number(user.token_version || 0) },
    config.jwtSecret,
    { expiresIn: config.tokenTtl }
  );
}

/** 沒有相依套件的 cookie 解析 */
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * 登入之後同時發一個 httpOnly cookie。
 *
 * 只有 /uploads 會用到它。原因是 <audio src="/uploads/…"> 與 <img src="…">
 * 沒辦法帶 Authorization 標頭 —— 要讓錄音與圖片需要身分才拿得到，就得靠
 * cookie。httpOnly 表示 JavaScript 讀不到，就算真的被 XSS 打到也偷不走。
 */
function setFileCookie(res, token) {
  const bits = [
    `${FILE_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/uploads',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${12 * 60 * 60}`,
  ];
  if (config.isProduction) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}
function clearFileCookie(res) {
  res.append('Set-Cookie', `${FILE_COOKIE}=; Path=/uploads; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  /* navigator.sendBeacon 沒有辦法帶自訂標頭。學生關掉分頁、或平板把分頁
     回收的時候，最後那一批作答只能靠 beacon 送出去 —— 沒有這一行的話
     那些請求全部會被擋在 401，而且前端已經沒有機會知道。
     只在 body 裡找，跟原本的 Bearer 一樣要通過 jwt.verify。

     ⚠ 這裡以前還接受 req.query.token。而後台的「匯出 CSV」「下載備份」
     都是 window.open('…?token=' + API.token) —— 於是管理員每按一次，
     就把一把 12 小時有效的全權限 token 寫進反向代理的存取日誌、瀏覽器
     歷史與下載紀錄。已經移除，前端改用 fetch + blob 下載。 */
  if (req.body && typeof req.body.token === 'string') return req.body.token;
  return null;
}

/** 驗 token 並取回使用者。回 null 表示不通過。 */
async function resolveUser(token) {
  if (!token) return null;
  let payload;
  try { payload = jwt.verify(token, config.jwtSecret); } catch { return null; }
  const user = await db.one(
    `SELECT id, username, name, email, role, class_group, candidate_no, active, token_version
       FROM users WHERE id = ?`, [payload.uid]
  );
  if (!user || !user.active) return null;
  // 改過密碼之後簽發的版本對不上，舊 token 一律作廢
  if (Number(user.token_version || 0) !== Number(payload.tv || 0)) return null;
  return user;
}

async function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: '請先登入' });
  const user = await resolveUser(token);
  if (!user) return res.status(401).json({ error: '登入已過期，請重新登入' });
  req.user = user;
  /* 檔案 cookie 自己補。
     沒有它的話 <audio src="/uploads/…"> 會拿到 401 —— 而那正是聽力考試
     開始的那一刻，學生會看到「音檔載入失敗」。升級前就登入的人、
     換了分頁、cookie 被清掉，都會走到這裡。所以只要有任何一個帶著
     Bearer 的請求通過驗證，就順手把 cookie 補成最新的。 */
  if (readCookie(req, FILE_COOKIE) !== token) setFileCookie(res, token);
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '請先登入' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: '權限不足' });
    next();
  };
}

const requireStaff = requireRole('admin', 'teacher');

module.exports = {
  sign, requireAuth, requireRole, requireStaff,
  resolveUser, readToken, readCookie, setFileCookie, clearFileCookie, FILE_COOKIE,
};
