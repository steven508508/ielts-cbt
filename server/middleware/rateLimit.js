'use strict';
/**
 * 極簡的記憶體型速率限制，用來擋登入暴力破解與 AI 端點被濫用。
 * 單機部署夠用；若之後要跑多個副本，改成 Redis 版本即可。
 */
const buckets = new Map();
const MAX_BUCKETS = 20_000;   // 上限，避免被大量不同 key 灌爆記憶體

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
}, 60_000).unref?.();

/** 取出這個請求該用哪一個計數桶 */
function bucketId(req, { key, by }) {
  if (by === 'user' && req.user?.id) return `${key}:u${req.user.id}`;
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return `${key}:${ip}`;
}

/**
 * @param {object} o
 * @param {number} o.windowMs  時間窗（毫秒）
 * @param {number} o.max       時間窗內允許的次數
 * @param {string} o.key       同一組設定用同一個前綴
 * @param {string} o.by        'ip'（預設）或 'user'（已登入的端點用這個比較準）
 * @param {string} o.message   超過時回傳的訊息
 */
function rateLimit({
  windowMs = 60_000, max = 30, key = 'default', by = 'ip',
  message = '操作太頻繁，請稍後再試',
} = {}) {
  return (req, res, next) => {
    // 計數的 key 絕對不能含使用者可控的值（例如帳號）。
    // 舊版把 username 放進 key，等於「每換一個帳號就重新給 20 次額度」，
    // 拿一份學生名單就能無限次嘗試密碼。
    const id = bucketId(req, { key, by });
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || b.resetAt < now) {
      if (buckets.size >= MAX_BUCKETS) {
        // 先掃掉過期的；還是滿的話就丟掉最舊的一筆（Map 保持插入順序）
        for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
        if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
      }
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
      return res.status(429).json({ error: `${message}（請於 ${wait} 秒後再試）`, retryAfter: wait });
    }
    next();
  };
}

/** 登入成功後把該 IP 的計數歸零 */
function reset(req, key = 'login') {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  buckets.delete(`${key}:${ip}`);
}

/** 給測試用 */
function _clear() { buckets.clear(); }

module.exports = { rateLimit, reset, _clear, MAX_BUCKETS };
