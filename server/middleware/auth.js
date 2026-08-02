'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

function sign(user) {
  return jwt.sign(
    { uid: user.id, username: user.username, role: user.role, name: user.name },
    config.jwtSecret,
    { expiresIn: config.tokenTtl }
  );
}

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (req.query && req.query.token) return String(req.query.token);
  /* navigator.sendBeacon 沒有辦法帶自訂標頭。學生關掉分頁、或平板把分頁
     回收的時候，最後那一批作答只能靠 beacon 送出去 —— 沒有這一行的話
     那些請求全部會被擋在 401，而且前端已經沒有機會知道。
     只在 body 裡找，跟原本的 Bearer 一樣要通過 jwt.verify。 */
  if (req.body && typeof req.body.token === 'string') return req.body.token;
  return null;
}

async function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: '請先登入' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await db.one('SELECT id, username, name, email, role, class_group, candidate_no, active FROM users WHERE id = ?', [payload.uid]);
    if (!user || !user.active) return res.status(401).json({ error: '帳號已停用' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: '登入已過期，請重新登入' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '請先登入' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: '權限不足' });
    next();
  };
}

const requireStaff = requireRole('admin', 'teacher');

module.exports = { sign, requireAuth, requireRole, requireStaff };
