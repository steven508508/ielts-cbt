'use strict';
/**
 * 極簡的記憶體型速率限制，用來擋登入暴力破解與 AI 端點被濫用。
 * 單機部署夠用；若之後要跑多個副本，改成 Redis 版本即可。
 */
const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
}, 60_000).unref?.();

/**
 * @param {object} o
 * @param {number} o.windowMs  時間窗（毫秒）
 * @param {number} o.max       時間窗內允許的次數
 * @param {string} o.key       同一組設定用同一個前綴
 * @param {string} o.message   超過時回傳的訊息
 */
function rateLimit({ windowMs = 60_000, max = 30, key = 'default', message = '操作太頻繁，請稍後再試' } = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const id = `${key}:${ip}:${req.body?.username || ''}`;
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(id, b);
    }
    b.count += 1;
    const remaining = Math.max(0, max - b.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (b.count > max) {
      const wait = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: `${message}（請於 ${wait} 秒後再試）` });
    }
    next();
  };
}

/** 登入成功後把該 IP 的計數歸零 */
function reset(req, key = 'login') {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  buckets.delete(`${key}:${ip}:${req.body?.username || ''}`);
}

module.exports = { rateLimit, reset };
