'use strict';
/**
 * 讓 async route handler 丟出的錯誤真的會被接住。
 *
 * Express 4 只接得住「同步 throw」與「呼叫 next(err)」。
 * 一個 async handler 裡的 await 如果 reject，Express 完全不知道，
 * 結果是：伺服器沒有回應、也沒有錯誤訊息，瀏覽器就一直轉圈到自己逾時。
 * 這種「卡住」比直接回 500 難查太多了 —— 使用者只看到一直讀取中，
 * 日誌也乾乾淨淨什麼都沒有。
 *
 * 這裡把每個 router 的 handler 包一層，把 rejection 轉成 next(err)，
 * 交給 index.js 的錯誤處理中介層回一個正常的 500。
 * 不必去改幾百個 route。
 */

function wrap(fn) {
  if (typeof fn !== 'function') return fn;
  if (fn.__asyncWrapped) return fn;
  if (fn.length >= 4) return fn;              // 錯誤處理中介層 (err,req,res,next) 不要動

  const wrapped = function (req, res, next) {
    let out;
    try {
      out = fn.call(this, req, res, next);
    } catch (e) {
      return next(e);
    }
    if (out && typeof out.then === 'function') out.then(undefined, next);
    return out;
  };
  wrapped.__asyncWrapped = true;
  // 保留原本的名稱，堆疊追蹤才看得懂
  Object.defineProperty(wrapped, 'name', { value: fn.name || 'handler' });
  return wrapped;
}

function wrapRouter(router) {
  if (!router || !Array.isArray(router.stack)) return router;
  for (const layer of router.stack) {
    if (layer.route && Array.isArray(layer.route.stack)) {
      for (const l of layer.route.stack) l.handle = wrap(l.handle);
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      wrapRouter(layer.handle);               // 巢狀 router
    } else {
      layer.handle = wrap(layer.handle);
    }
  }
  return router;
}

module.exports = { wrapRouter, wrap };
