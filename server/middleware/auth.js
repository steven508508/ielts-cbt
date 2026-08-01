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
