'use strict';
/**
 * 雅思分數換算。
 * 注意：官方每一場考試的原始分對照表都會微調，以下為業界公開的通用對照表，
 * 用於模擬考已足夠。老師可在「系統設定 → 分數對照表」自行修改。
 */

// [最低原始分, band]，由高到低
const DEFAULT_TABLES = {
  listening: [
    [39, 9.0], [37, 8.5], [35, 8.0], [32, 7.5], [30, 7.0], [26, 6.5], [23, 6.0],
    [18, 5.5], [16, 5.0], [13, 4.5], [10, 4.0], [8, 3.5], [6, 3.0], [4, 2.5],
    [3, 2.0], [2, 1.5], [1, 1.0], [0, 0.0],
  ],
  reading_academic: [
    [39, 9.0], [37, 8.5], [35, 8.0], [33, 7.5], [30, 7.0], [27, 6.5], [23, 6.0],
    [19, 5.5], [15, 5.0], [13, 4.5], [10, 4.0], [8, 3.5], [6, 3.0], [4, 2.5],
    [3, 2.0], [2, 1.5], [1, 1.0], [0, 0.0],
  ],
  reading_general: [
    [40, 9.0], [39, 8.5], [37, 8.0], [36, 7.5], [34, 7.0], [32, 6.5], [30, 6.0],
    [27, 5.5], [23, 5.0], [19, 4.5], [15, 4.0], [12, 3.5], [9, 3.0], [6, 2.5],
    [4, 2.0], [2, 1.5], [1, 1.0], [0, 0.0],
  ],
};

/** 半分制四捨五入（.25 進位到 .5、.75 進位到整數） */
function roundHalfBand(x) {
  if (x == null || Number.isNaN(x)) return null;
  return Math.round(x * 2 + 1e-9) / 2;
}

/**
 * 原始分 → band。若總題數不是 40，會等比例換算成 40 題制再查表。
 */
function rawToBand(rawScore, total, module, testType = 'academic', tables = DEFAULT_TABLES) {
  const key = module === 'reading' ? `reading_${testType === 'general' ? 'general' : 'academic'}` : 'listening';
  const table = tables[key] || DEFAULT_TABLES[key];
  if (!total || total <= 0) return null;
  const scaled = Math.round((rawScore / total) * 40);
  for (const [min, band] of table) if (scaled >= min) return band;
  return 0;
}

/** 寫作／口說：四項評分標準平均 */
function criteriaToBand(criteria) {
  const vals = Object.values(criteria || {}).map(Number).filter((n) => !Number.isNaN(n));
  if (!vals.length) return null;
  return roundHalfBand(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** 總分：四科平均後半分制四捨五入 */
function overallBand(bands) {
  const vals = [bands.listening, bands.reading, bands.writing, bands.speaking]
    .map((v) => (v == null ? null : Number(v)))
    .filter((v) => v != null && !Number.isNaN(v));
  if (!vals.length) return null;
  return roundHalfBand(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** Band → CEFR 對照（官方公告的對應） */
function cefrLevel(band) {
  if (band == null) return '';
  if (band >= 8.5) return 'C2';
  if (band >= 7.0) return 'C1';
  if (band >= 5.5) return 'B2';
  if (band >= 4.0) return 'B1';
  if (band >= 3.0) return 'A2';
  return 'A1';
}

const BAND_SUMMARY = {
  9: { en: 'Expert user', zh: '專家級：能完全掌握英語，運用自如、準確流利，理解透徹。' },
  8: { en: 'Very good user', zh: '優秀：僅偶有不系統性的錯誤與不當用法，能處理複雜論證。' },
  7: { en: 'Good user', zh: '良好：能有效運用英語，偶有不準確或誤解，大致能處理複雜語言。' },
  6: { en: 'Competent user', zh: '合格：大致能有效運用，雖有不準確與誤解，熟悉情境下溝通無礙。' },
  5: { en: 'Modest user', zh: '中等：能部分掌握，多數情況能理解大意，但常會犯錯。' },
  4: { en: 'Limited user', zh: '有限：僅限熟悉情境，理解與表達常有問題，無法使用複雜語言。' },
  3: { en: 'Extremely limited user', zh: '極有限：僅能在極熟悉的情境傳達與理解大致意思，溝通常中斷。' },
  2: { en: 'Intermittent user', zh: '斷續：除最基本資訊外難以溝通。' },
  1: { en: 'Non-user', zh: '不能使用：僅會少數單字。' },
  0: { en: 'Did not attempt the test', zh: '未作答。' },
};

function bandSummary(band) {
  if (band == null) return null;
  return BAND_SUMMARY[Math.floor(band)] || BAND_SUMMARY[0];
}

// 寫作與口說的四大評分標準
const WRITING_CRITERIA = {
  TA: { en: 'Task Achievement / Task Response', zh: '任務完成度' },
  CC: { en: 'Coherence and Cohesion', zh: '連貫與銜接' },
  LR: { en: 'Lexical Resource', zh: '詞彙豐富度' },
  GRA: { en: 'Grammatical Range and Accuracy', zh: '文法多樣性與準確度' },
};

const SPEAKING_CRITERIA = {
  FC: { en: 'Fluency and Coherence', zh: '流利度與連貫性' },
  LR: { en: 'Lexical Resource', zh: '詞彙豐富度' },
  GRA: { en: 'Grammatical Range and Accuracy', zh: '文法多樣性與準確度' },
  PRO: { en: 'Pronunciation', zh: '發音' },
};

module.exports = {
  DEFAULT_TABLES, roundHalfBand, rawToBand, criteriaToBand, overallBand,
  cefrLevel, bandSummary, BAND_SUMMARY, WRITING_CRITERIA, SPEAKING_CRITERIA,
};
