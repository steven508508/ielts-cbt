'use strict';
/**
 * 考試紀律事件的分級。
 *
 * 為什麼要分級：舊版把所有事件都當成同一件事，於是「麥克風權限被擋，
 * 學生退出全螢幕去瀏覽器設定開權限」跟「考到一半切去查字典」記成一樣的東西，
 * 而且一起累加進自動收卷的門檻。老師看到的是一份寫著「離開 3 次」的紀錄，
 * 完全看不出來其中兩次是系統自己造成的。
 *
 * 三個等級：
 *   info  —— 系統紀錄或裝置問題，不算違規，也不計入離開次數
 *   warn  —— 一般違規，計入次數
 *   alert —— 明顯可疑，計入次數而且要醒目
 */

/** 這些科目本來就不要求全螢幕（前端 startModule 也是這樣判的）*/
const NO_FULLSCREEN_MODULES = ['speaking'];

/** 處理裝置權限的寬限時間：這段時間內離開畫面視為裝置問題 */
const DEVICE_GRACE_MS = 3 * 60 * 1000;

// audio_error / render_gap 是系統自己出的問題，絕對不能算到學生頭上
const ALWAYS_INFO = ['return', 'fullscreen_enter', 'resize', 'device_permission', 'device_check',
  'audio_error', 'render_gap'];
const ALWAYS_ALERT = ['copy_blocked', 'devtools', 'auto_submit'];

/**
 * @param {string} type      事件類型
 * @param {object} ctx
 * @param {string} ctx.module            發生在哪一科
 * @param {number} ctx.msSinceDeviceIssue  距離上一次裝置問題幾毫秒（沒有就傳 null）
 * @returns {{severity:'info'|'warn'|'alert', reason:string|null}}
 */
function classify(type, { module = null, msSinceDeviceIssue = null } = {}) {
  if (ALWAYS_INFO.includes(type)) return { severity: 'info', reason: null };
  if (ALWAYS_ALERT.includes(type)) return { severity: 'alert', reason: null };

  // 口說不要求全螢幕，那離開全螢幕就不該算違規 ——
  // 這是舊版的 bug：startModule 刻意不在口說時要求全螢幕，
  // 但 fullscreenchange 的判定沒跟著排除，於是前一科帶進來的全螢幕
  // 一退出就被記一筆。
  if (type === 'fullscreen_exit' && NO_FULLSCREEN_MODULES.includes(module)) {
    return { severity: 'info', reason: '這一科本來就不要求全螢幕' };
  }

  // 剛回報過裝置問題（例如麥克風權限被拒），接下來幾分鐘的離開
  // 極可能是去改瀏覽器設定。時間由伺服器算，前端說了不算。
  if (msSinceDeviceIssue != null && msSinceDeviceIssue >= 0 && msSinceDeviceIssue < DEVICE_GRACE_MS
      && ['leave', 'fullscreen_exit'].includes(type)) {
    return { severity: 'info', reason: '正在處理裝置權限' };
  }

  return { severity: 'warn', reason: null };
}

/** 哪些事件算「離開考試畫面」 */
const LEAVE_TYPES = ['leave', 'fullscreen_exit'];

/**
 * 「離開次數」只有一個定義，就寫在這裡。
 *
 * 以前這條規則被抄成三份 SQL 散在 exam.js 與 results.js 裡，而且抄錯了一份：
 * 回報事件當下算的有排除 info，但學生一重新整理，考卷帶回來的次數又把
 * info 算了進去。於是「麥克風權限被擋、去改設定」明明被判定為不算違規，
 * 學生只要重新整理頁面，次數就突然跳上去，下一個小動作就被自動收卷。
 */
const LEAVE_WHERE = "type IN ('leave','fullscreen_exit') AND severity <> 'info'";

/** 只有 warn 以上才計入「離開次數」（自動收卷的門檻用這個）*/
function countsAsLeave(severity) {
  return severity === 'warn' || severity === 'alert';
}

/**
 * 到了要處置的程度了嗎。
 *
 * maxLeaves 在介面上寫的是「**允許**離開畫面幾次」、處置寫的是「**超過**上限時」，
 * 所以 maxLeaves = 2 的意思是「離開兩次沒關係，第三次才處置」。
 * 舊版用 `count >= maxLeaves`，在第二次就收卷，比老師設定的嚴格一級。
 */
function exceedsLimit(count, maxLeaves) {
  const limit = Number(maxLeaves) || 0;
  return limit > 0 && Number(count) > limit;
}

/** 還可以離開幾次才會被處置 */
function remainingLeaves(count, maxLeaves) {
  const limit = Number(maxLeaves) || 0;
  if (limit <= 0) return Infinity;
  return Math.max(0, limit - Number(count) + 1);
}

const SEVERITY_LABEL = {
  info: '紀錄',
  warn: '需留意',
  alert: '可疑',
};

module.exports = {
  classify, countsAsLeave, exceedsLimit, remainingLeaves, SEVERITY_LABEL,
  LEAVE_TYPES, LEAVE_WHERE,
  NO_FULLSCREEN_MODULES, DEVICE_GRACE_MS, ALWAYS_INFO, ALWAYS_ALERT,
};
