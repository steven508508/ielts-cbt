'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { sign, requireAuth, setFileCookie, clearFileCookie, readToken } = require('../middleware/auth');
const { rateLimit, reset } = require('../middleware/rateLimit');
const turnstile = require('../lib/turnstile');

const router = express.Router();

const loginLimiter = rateLimit({
  key: 'login', windowMs: 10 * 60_000, max: 20,
  message: '登入嘗試次數過多',
});

/** 登入頁需要的公開設定（未登入即可讀，不含任何機密） */
router.get('/config', async (req, res) => {
  res.json({ turnstile: await turnstile.publicConfig() });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password, turnstileToken } = req.body || {};

  // 先過人機驗證，再比對帳密（沒啟用時直接放行）
  const check = await turnstile.verify(turnstileToken, req.ip);
  if (!check.ok) return res.status(400).json({ error: check.reason, turnstileFailed: true });

  if (!username || !password) return res.status(400).json({ error: '請輸入帳號與密碼' });
  const user = await db.one('SELECT * FROM users WHERE username = ?', [String(username).trim()]);
  if (!user || !user.active) return res.status(401).json({ error: '帳號或密碼錯誤' });
  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) return res.status(401).json({ error: '帳號或密碼錯誤' });
  reset(req, 'login');
  const token = sign(user);
  // <audio src> / <img src> 帶不了 Authorization 標頭，/uploads 靠這個 cookie 認人
  setFileCookie(res, token);
  res.json({
    token,
    user: {
      id: user.id, username: user.username, name: user.name, role: user.role,
      email: user.email, classGroup: user.class_group, candidateNo: user.candidate_no,
    },
  });
});

router.get('/me', requireAuth, (req, res) => {
  /* 順手把檔案存取的 cookie 補上。前端每次載入都會打這一支，
     所以更新版本之前就登入的人不必重新登入，錄音與圖片也拿得到。 */
  setFileCookie(res, readToken(req));
  res.json({ user: req.user });
});

router.post('/password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6)
    return res.status(400).json({ error: '新密碼至少 6 個字元' });
  const row = await db.one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(String(oldPassword || ''), row.password_hash)))
    return res.status(400).json({ error: '舊密碼不正確' });
  /* token_version + 1：改完密碼，所有舊 token（包含攻擊者手上那把）立刻失效。
     以前只更新 password_hash —— 帳號外流之後改密碼根本踢不掉對方。 */
  await db.exec(
    'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
    [await bcrypt.hash(String(newPassword), 10), req.user.id]
  );
  // 自己這一次要換一把新的，不然改完密碼會把自己踢出去
  const fresh = await db.one('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const token = sign(fresh);
  setFileCookie(res, token);
  res.json({ ok: true, token });
});

/** 登出：把檔案存取的 cookie 收回來 */
router.post('/logout', (req, res) => {
  clearFileCookie(res);
  res.json({ ok: true });
});

module.exports = router;
