'use strict';
/**
 * 考前環境診斷。
 *
 * POST /api/check 是全站唯一一支不用登入就能寫入的端點，
 * 所以：① 有速率限制 ② 只收白名單欄位 ③ 每欄截斷 ④ 回應不夾帶任何別人的資料。
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { requireAuth, requireStaff } = require('../middleware/auth');
const scope = require('../lib/scope');
const { rateLimit } = require('../middleware/rateLimit');
const devicecheck = require('../lib/devicecheck');

const router = express.Router();

/** 診斷頁需要的公開資訊（不用登入）*/
router.get('/config', async (req, res) => {
  const turnstile = require('../lib/turnstile');
  const cfg = await turnstile.publicConfig().catch(() => ({ enabled: false }));
  res.json({
    checks: Object.fromEntries(
      Object.entries(devicecheck.CHECKS).map(([k, v]) => [k, { label: v.label, critical: v.critical }])),
    turnstileEnabled: !!cfg.enabled,
    serverTime: Date.now(),
    wsPath: '/ws/speaking',
  });
});

/**
 * 回報一次診斷結果。沒登入也收（學生考前自己在家測），
 * 有帶 token 就綁到那個學生身上。
 */
router.post('/', rateLimit({ key: 'devicecheck', by: 'ip', windowMs: 60_000, max: 12 }), async (req, res) => {
  // 這裡刻意不用 requireAuth：沒 token 也要能存。有 token 才認人。
  let userId = null;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(h.slice(7), config.jwtSecret);
      const u = await db.one('SELECT id FROM users WHERE id = ? AND active = 1', [payload.uid]);
      userId = u?.id || null;
    } catch { userId = null; }   // token 過期就當作沒登入，不要讓診斷失敗
  }

  const out = await devicecheck.save({
    raw: req.body?.results,
    userId,
    ua: req.headers['user-agent'],
    ip: req.ip,
  });
  res.json({
    ok: out.ok, score: out.score, code: out.code,
    summary: out.summary, criticalFails: out.criticalFails, saved: true,
  });
});

/** 老師端：誰測過、誰有問題 */
router.get('/list', requireAuth, requireStaff, async (req, res) => {
  const items = await devicecheck.list({
    limit: req.query.limit,
    userId: req.query.userId,
    onlyProblems: req.query.problems === '1',
  });
  /* 班級隔離。沒登入就測的那些沒有 class_group，一律只給不受限制的人看 ——
     受限的老師看到一堆匿名紀錄也沒有意義。 */
  const mine = await scope.classesOf(req.user);
  res.json({
    items: mine === null ? items
      : items.filter((i) => i.class_group && mine.includes(String(i.class_group))),
  });
});

module.exports = router;
