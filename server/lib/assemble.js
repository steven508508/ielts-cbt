'use strict';
/**
 * 自動組卷：依目標題數／難度／題型，從題庫抽題組成一份試卷。
 *
 * 設計上刻意「不夠就老實說」——湊不到目標題數時不會硬塞或重複用同一個
 * 題組，而是回報還差幾題、缺哪一個科目，讓老師知道要再補什麼進題庫。
 */
const { normalizePaper, validatePaper, QUESTION_TYPES } = require('./paper');

/** 官方的分節結構：聽力 4 節、閱讀 3 篇 */
const SECTION_PLAN = {
  listening: { count: 4, name: (i) => `Section ${i + 1}` },
  reading: { count: 3, name: (i) => `Reading Passage ${i + 1}` },
  writing: { count: 1, name: () => 'Writing' },
  speaking: { count: 1, name: () => 'Speaking' },
};

const DEFAULT_TARGETS = { listening: 40, reading: 40, writing: 2, speaking: 1 };

/** 題庫一筆 = 幾題 */
function itemSize(item) {
  const g = item.payload?.group || (item.payload?.groups || [])[0];
  if (!g) return 0;
  if (g.type === 'writing_task' || g.type === 'speaking_part') return (g.questions || []).length;
  return (g.questions || []).length;
}

/** 洗牌。給定 seed 時結果可重現，方便測試與「換一組」。 */
function shuffle(arr, seed = null) {
  const a = [...arr];
  let rnd;
  if (seed == null) {
    rnd = () => Math.random();
  } else {
    let s = Number(seed) >>> 0 || 1;
    rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 從候選題組裡挑到接近目標題數。
 * 會盡量讓題型分散——官方每一節都會混 2～3 種題型，
 * 全部都是 T/F/NG 的考卷一看就知道是湊出來的。
 */
function pickForModule(candidates, target, { tolerance = 2 } = {}) {
  const picked = [];
  const usedTypes = new Map();
  let total = 0;

  // 依「這個題型已經用了幾次」排序，用得少的先挑
  const remaining = [...candidates];
  while (remaining.length && total < target) {
    remaining.sort((a, b) => {
      const ua = usedTypes.get(a.type) || 0;
      const ub = usedTypes.get(b.type) || 0;
      if (ua !== ub) return ua - ub;
      // 同樣冷門時，優先挑「剛好補得上剩餘題數」的
      const need = target - total;
      return Math.abs(itemSize(a) - need) - Math.abs(itemSize(b) - need);
    });

    // 找第一個放得下的（不能超出容許值太多）
    const idx = remaining.findIndex((c) => total + itemSize(c) <= target + tolerance);
    if (idx < 0) break;
    const chosen = remaining.splice(idx, 1)[0];
    picked.push(chosen);
    usedTypes.set(chosen.type, (usedTypes.get(chosen.type) || 0) + 1);
    total += itemSize(chosen);
  }
  return { picked, total, typeMix: [...usedTypes.entries()].map(([t, n]) => ({ type: t, groups: n })) };
}

/** 把挑到的題組平均分到官方的節數裡 */
function toSections(module, picked) {
  const plan = SECTION_PLAN[module] || { count: 1, name: (i) => `Section ${i + 1}` };
  const buckets = Array.from({ length: plan.count }, () => []);

  if (['writing', 'speaking'].includes(module)) {
    buckets[0] = picked;
  } else {
    // 依題數輪流放進最空的那一節，讓每一節題數盡量接近
    const sizes = new Array(plan.count).fill(0);
    for (const item of picked) {
      let min = 0;
      for (let i = 1; i < plan.count; i += 1) if (sizes[i] < sizes[min]) min = i;
      buckets[min].push(item);
      sizes[min] += itemSize(item);
    }
  }

  return buckets
    .map((items, i) => {
      if (!items.length) return null;
      // 一節可以有多個題組，但文章／逐字稿只能有一份 ——
      // 所以同一節裡只保留第一個帶文章的，其餘題組附在後面
      const withText = items.find((x) => x.payload?.passage || x.payload?.transcript);
      return {
        title: plan.name(i),
        passageTitle: withText?.payload?.passageTitle || null,
        passage: withText?.payload?.passage || null,
        transcript: withText?.payload?.transcript || null,
        groups: items.flatMap((x) => (x.payload?.group ? [x.payload.group] : (x.payload?.groups || []))),
        _sources: items.map((x) => x.id),
      };
    })
    .filter(Boolean);
}

/** 整份試卷的客觀題重新連續編號 */
function renumber(paper) {
  for (const mod of paper.modules || []) {
    let n = 0;
    for (const sec of mod.sections || []) {
      for (const g of sec.groups || []) {
        if (!QUESTION_TYPES[g.type]?.objective) continue;
        for (const q of g.questions || []) { n += 1; q.number = n; }
        if (g.bodyHtml) {
          // bodyHtml 裡的 [[題號]] 也要跟著換，不然驗證會說空格對不上
          const nums = (g.questions || []).map((q) => q.number);
          let k = 0;
          g.bodyHtml = g.bodyHtml.replace(/\[\[\s*\d+\s*\]\]/g, () => `[[${nums[k++] ?? ''}]]`);
        }
      }
    }
  }
  return paper;
}

/**
 * 主流程。
 * @param {object[]} bank      題庫（已 JSON.parse 過 payload）
 * @param {object}   o
 * @param {object}   o.targets  各科目標題數，例如 { listening: 40, reading: 40 }
 * @param {string}   o.difficulty 只挑這個難度（湊不夠時會自動放寬）
 * @param {string[]} o.types    只挑這些題型（可省略）
 * @param {number}   o.seed     指定後結果可重現
 */
function assemble(bank, {
  title = '自動組卷', testType = 'academic',
  targets = DEFAULT_TARGETS, difficulty = '', types = null, seed = null,
} = {}) {
  const modules = [];
  const report = { picked: {}, shortfall: {}, relaxed: [], usedIds: [] };

  for (const [module, targetRaw] of Object.entries(targets)) {
    const target = Number(targetRaw) || 0;
    if (target <= 0) continue;

    let pool = bank.filter((b) => b.module === module && itemSize(b) > 0);
    if (types?.length) pool = pool.filter((b) => types.includes(b.type));

    // 先照難度挑；不夠的話放寬，但要講出來
    let scoped = difficulty ? pool.filter((b) => (b.difficulty || '') === difficulty) : pool;
    const scopedTotal = scoped.reduce((n, b) => n + itemSize(b), 0);
    if (difficulty && scopedTotal < target) {
      scoped = pool;
      report.relaxed.push(module);
    }

    const { picked, total, typeMix } = pickForModule(shuffle(scoped, seed), target);
    if (!picked.length) {
      report.shortfall[module] = { got: 0, want: target, missing: target };
      continue;
    }

    const sections = toSections(module, picked);
    sections.forEach((s) => report.usedIds.push(...s._sources));
    sections.forEach((s) => { delete s._sources; });

    modules.push({ module, sections });
    report.picked[module] = { groups: picked.length, questions: total, target, typeMix };
    if (total < target) report.shortfall[module] = { got: total, want: target, missing: target - total };
  }

  if (!modules.length) {
    return { ok: false, error: '題庫裡沒有符合條件的題組', report, paper: null };
  }

  const paper = renumber(normalizePaper({
    title,
    testType: testType === 'general' ? 'general' : 'academic',
    description: '由題庫自動組成，請人工校對後再指派。',
    modules,
  }));

  const result = validatePaper(paper);
  return {
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings,
    stats: result.stats,
    paper: result.paper,
    report,
  };
}

/** 給前端看的「題庫夠不夠」統計 */
function coverage(bank) {
  const out = {};
  for (const b of bank) {
    const n = itemSize(b);
    if (!n) continue;
    const m = (out[b.module] = out[b.module] || { groups: 0, questions: 0, byType: {}, byDifficulty: {} });
    m.groups += 1;
    m.questions += n;
    m.byType[b.type] = (m.byType[b.type] || 0) + n;
    const d = b.difficulty || '（未標難度）';
    m.byDifficulty[d] = (m.byDifficulty[d] || 0) + n;
  }
  return out;
}

module.exports = { assemble, coverage, itemSize, pickForModule, renumber, shuffle, DEFAULT_TARGETS, SECTION_PLAN };
