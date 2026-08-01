'use strict';
const express = require('express');
const { requireAuth, requireStaff, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const notify = require('../lib/notify');
const db = require('../db');

const router = express.Router();
router.use(requireAuth);

/** 我的通知 */
router.get('/', async (req, res) => {
  res.json(await notify.listFor(req.user.id, {
    limit: req.query.limit,
    unreadOnly: req.query.unread === '1',
  }));
});

/** 只要未讀數（頁首的鈴鐺用，回應很小可以常打） */
router.get('/count', async (req, res) => {
  const r = await db.one(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
  res.json({ unread: Number(r?.n || 0) });
});

router.post('/read', async (req, res) => {
  const n = await notify.markRead(req.user.id, req.body?.ids || null);
  res.json({ ok: true, marked: n });
});

/** 老師主動發通知給學生或整個班 */
router.post('/send', requireStaff, rateLimit({ key: 'notify', by: 'user', windowMs: 60_000, max: 10 }),
  async (req, res) => {
    const { title, body, classGroup, userIds } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: '請填標題' });

    let ids = (userIds || []).map(Number).filter(Boolean);
    if (classGroup) {
      const rows = await db.query(
        "SELECT id FROM users WHERE class_group = ? AND role = 'student' AND active = 1", [classGroup]);
      ids = ids.concat(rows.map((r) => r.id));
    }
    if (!ids.length) return res.status(400).json({ error: '沒有選到任何收件者' });

    const r = await notify.push(ids, {
      type: 'message',
      title: String(title).trim(),
      body: body ? String(body).trim() : null,
    });
    res.json({ ok: true, ...r });
  });

// ── SMTP 設定（選用）────────────────────────────────────────
router.get('/smtp', requireStaff, async (req, res) => {
  res.json({ smtp: notify.maskSmtp(await notify.getSmtp(true)) });
});

router.put('/smtp', requireRole('admin'), async (req, res) => {
  const t = req.body?.smtp || {};
  const patch = {};
  for (const k of ['host', 'from', 'fromName', 'user']) if (t[k] !== undefined) patch[k] = String(t[k]);
  if (t.port !== undefined) patch.port = Number(t.port) || 587;
  if (t.enabled !== undefined) patch.enabled = !!t.enabled;
  if (t.secure !== undefined) patch.secure = !!t.secure;
  // 前端送回遮罩過的密碼時不要覆寫
  if (t.pass !== undefined && !/^•+$/.test(String(t.pass))) patch.pass = String(t.pass);
  res.json({ ok: true, smtp: notify.maskSmtp(await notify.saveSmtp(patch)) });
});

/** 寄一封測試信給自己 */
router.post('/smtp/test', requireRole('admin'),
  rateLimit({ key: 'smtp-test', by: 'user', windowMs: 60_000, max: 3 }),
  async (req, res) => {
    const cfg = await notify.getSmtp(true);
    if (!cfg.host || !cfg.from) return res.status(400).json({ error: '請先填 SMTP 主機與寄件人' });
    const to = String(req.body?.to || req.user.email || '').trim();
    if (!to) return res.status(400).json({ error: '請填收件信箱（或先在「我的帳號」設定 Email）' });
    try {
      await notify.smtpSend({
        host: cfg.host, port: cfg.port, secure: cfg.secure,
        user: cfg.user, pass: cfg.pass, from: cfg.from, fromName: cfg.fromName,
        to: [to], subject: 'IELTS 模擬考：測試信',
        text: '這是一封測試信。你收到這封信，代表 SMTP 設定正確。',
      });
      res.json({ ok: true, message: `測試信已寄到 ${to}` });
    } catch (e) {
      res.status(502).json({ ok: false, error: `寄不出去：${e.message}` });
    }
  });

module.exports = router;
