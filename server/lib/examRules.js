'use strict';
/**
 * 把「試卷預設」與「老師在指派時的設定」合併成這一場考試實際要用的規則。
 *
 * 優先順序（後面蓋前面）：
 *   1. 系統預設（paper.js 的 MODULE_DEFAULTS）
 *   2. 試卷 JSON 裡的 durationSec / transferSec
 *   3. 指派時的每科時間覆寫 duration_overrides
 *   4. 額外時間百分比 extra_time_pct（無障礙加時，最後才乘上去）
 */
const { MODULE_DEFAULTS } = require('./paper');

// ── 反作弊預設值：全部關閉，老師要自己打開 ────────────────────
const PROCTORING_DEFAULT = {
  enabled: false,
  requireFullscreen: false,  // 強制全螢幕，離開會被要求回去
  blockCopy: false,          // 擋住從文章複製、以及從外部貼進作文
  warnOnLeave: true,         // 切換分頁／視窗失焦時跳警告
  maxLeaves: 0,              // 允許離開幾次（0 = 不限，只記錄）
  onExceed: 'warn',          // 超過上限的處置：warn（僅警告）| submit（自動結束該科）
};

const BREAK_POLICIES = {
  // 官方流程：聽力 → 閱讀 → 寫作 連續不中斷，中間只有短暫過場；口說獨立
  official: { label: '官方流程（聽讀寫連續不中斷）', chain: ['listening', 'reading', 'writing'], gapSec: 15 },
  // 固定休息：每科之間休息 N 分鐘，時間到自動進入下一科
  timed: { label: '固定休息時間', chain: ['listening', 'reading', 'writing'], gapSec: null },
  // 自由：回到科目清單，學生自己決定何時開始下一科
  flexible: { label: '自由（學生自己決定何時開始下一科）', chain: null, gapSec: null },
};

function safeParse(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s) ?? fallback; } catch { return fallback; }
}

/**
 * @param {object|null} assignment  assignments 資料列
 * @param {object} paper            正規化過的試卷
 * @param {string[]} modules        這場考試要考的科目
 */
function resolveRules(assignment, paper, modules) {
  const overrides = safeParse(assignment?.duration_overrides, {}) || {};
  const extraPct = Math.max(0, Math.min(200, Number(assignment?.extra_time_pct || 0)));

  const durations = {};
  const breakdown = {};
  for (const name of modules) {
    const mod = (paper.modules || []).find((m) => m.module === name);
    const def = MODULE_DEFAULTS[name] || { durationSec: 1800, transferSec: 0 };
    const base = Number(mod?.durationSec || def.durationSec);
    const transfer = Number(mod?.transferSec ?? def.transferSec ?? 0);
    const overridden = Number(overrides[name]);
    const beforeExtra = Number.isFinite(overridden) && overridden > 0 ? overridden : base + transfer;
    const extra = Math.round(beforeExtra * (extraPct / 100));
    durations[name] = beforeExtra + extra;
    breakdown[name] = {
      paperSec: base + transfer,
      overrideSec: Number.isFinite(overridden) && overridden > 0 ? overridden : null,
      extraSec: extra,
      totalSec: durations[name],
    };
  }

  const proctoring = { ...PROCTORING_DEFAULT, ...(safeParse(assignment?.proctoring, {}) || {}) };
  proctoring.maxLeaves = Math.max(0, Number(proctoring.maxLeaves) || 0);
  if (!['warn', 'submit'].includes(proctoring.onExceed)) proctoring.onExceed = 'warn';

  const policy = BREAK_POLICIES[assignment?.break_policy] ? assignment.break_policy : 'flexible';
  const breakSeconds = policy === 'timed'
    ? Math.max(0, Number(assignment?.break_seconds || 0))
    : (BREAK_POLICIES[policy].gapSec || 0);

  // 連續作答的科目順序（口說一律獨立，不納入連鎖）
  const chain = BREAK_POLICIES[policy].chain
    ? BREAK_POLICIES[policy].chain.filter((m) => modules.includes(m))
    : null;

  return {
    durations,
    breakdown,
    extraTimePct: extraPct,
    proctoring,
    break: { policy, label: BREAK_POLICIES[policy].label, seconds: breakSeconds, chain },
  };
}

module.exports = { resolveRules, PROCTORING_DEFAULT, BREAK_POLICIES };
