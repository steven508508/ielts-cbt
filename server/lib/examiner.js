'use strict';
/**
 * AI 口說考官的可調設定。
 *
 * 兩層：管理員在「系統設定 → AI 考官」設全站預設，老師指派考試時可以針對
 * 特定班級覆寫。沒覆寫的欄位一律沿用上一層，所以老師只要改他在意的那一兩項。
 *
 *   內建預設  ←  系統設定  ←  這一場指派
 *
 * 為什麼要能調：同一套設定不可能同時適合初級班和衝刺班。最常被調的是
 * 「停頓多久算講完」—— 程度較低的學生講話停頓多，1.1 秒會一直被搶話。
 */

const ACCENTS = {
  british: { label: '英式 British', prompt: 'British English (standard southern British / RP)' },
  american: { label: '美式 American', prompt: 'American English (General American)' },
  australian: { label: '澳式 Australian', prompt: 'Australian English' },
};

const PACES = {
  slow: { label: '慢（適合初級）', prompt: 'Speak slowly and very clearly, leaving generous pauses between sentences.' },
  normal: { label: '正常', prompt: 'Speak at a natural, unhurried pace.' },
  brisk: { label: '偏快（接近真實考場）', prompt: 'Speak at a brisk but still natural pace, as an experienced examiner would.' },
};

const STYLES = {
  warm: { label: '親切', prompt: 'Your manner is warm and encouraging, though you still never give feedback or praise.' },
  neutral: { label: '中性專業', prompt: 'Your manner is polite, neutral and professional.' },
  formal: { label: '嚴肅正式', prompt: 'Your manner is formal and businesslike, strictly to the point.' },
};

const FOLLOW_UPS = {
  few: { label: '少（照題目問就好）', prompt: 'Ask the scripted questions and move on. Only add a follow-up if the candidate says almost nothing.' },
  standard: { label: '標準', prompt: 'Add one short natural follow-up per topic, based on what the candidate actually said.' },
  many: { label: '多（逼學生延伸）', prompt: 'Probe actively. After most answers, ask one follow-up that pushes the candidate to explain, justify or give an example. Never let a short answer stand.' },
};

const STRICTNESS = {
  lenient: { label: '寬鬆（鼓勵為主）', prompt: 'Mark generously. When an answer sits between two bands, award the higher one.' },
  standard: { label: '官方標準', prompt: 'Mark to the official public band descriptors, no more and no less.' },
  strict: { label: '嚴格（保守估分）', prompt: 'Mark conservatively. When an answer sits between two bands, award the lower one.' },
};

/** 內建預設值 */
const DEFAULTS = {
  // 人設與口音
  name: 'Sarah',
  voice: '',                 // 留空 = 沿用「系統設定 → AI」的語音
  accent: 'british',
  pace: 'normal',
  style: 'neutral',
  extraInstructions: '',

  // 換手靈敏度
  silenceMs: 1100,           // 一問一答：停頓多久算講完
  longTurnSilenceMs: 2000,   // Part 2 長回答與準備時間
  allowBargeIn: true,        // 學生可不可以插話把考官打斷

  // 難度與追問
  followUps: 'standard',
  strictness: 'standard',
  part1Sec: 300,             // Part 1 大約講多久就換 Part 2
  part3Sec: 300,
  prepSec: 60,               // 試卷的提示卡沒寫時用這個
  talkSec: 120,

  // 學生在考試中看得到什麼
  // 即時分數預設「不給看」—— 真實 IELTS 不會邊考邊報分數，
  // 而且看到分數往下掉對正在講話的學生只有干擾。
  showLiveScore: false,
  showTranscript: true,
  showPhase: true,
  showCueCard: true,
  showLevelMeter: true,
};

const NUM_RANGES = {
  silenceMs: [400, 5000],
  longTurnSilenceMs: [800, 8000],
  part1Sec: [60, 900],
  part3Sec: [60, 900],
  prepSec: [10, 300],
  talkSec: [30, 600],
};

const BOOL_KEYS = ['allowBargeIn', 'showLiveScore', 'showTranscript', 'showPhase', 'showCueCard', 'showLevelMeter'];
const ENUMS = { accent: ACCENTS, pace: PACES, style: STYLES, followUps: FOLLOW_UPS, strictness: STRICTNESS };

/**
 * 把使用者送來的東西清成安全的設定。
 * 只保留認得的欄位，數字夾在合理範圍內，看不懂的值直接忽略（不是報錯）——
 * 這樣舊版存的設定被新版讀到時不會整組壞掉。
 */
function normalize(input, base = DEFAULTS) {
  const out = { ...base };
  if (!input || typeof input !== 'object') return out;

  if (typeof input.name === 'string') out.name = input.name.trim().slice(0, 40) || base.name;
  if (typeof input.voice === 'string') out.voice = input.voice.trim().slice(0, 40);
  if (typeof input.extraInstructions === 'string') {
    out.extraInstructions = input.extraInstructions.trim().slice(0, 2000);
  }
  for (const [k, table] of Object.entries(ENUMS)) {
    if (input[k] != null && table[String(input[k])]) out[k] = String(input[k]);
  }
  for (const [k, [lo, hi]] of Object.entries(NUM_RANGES)) {
    if (input[k] == null || input[k] === '') continue;
    const n = Number(input[k]);
    if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, Math.round(n)));
  }
  for (const k of BOOL_KEYS) {
    if (input[k] != null) out[k] = !!input[k];
  }
  return out;
}

/** 只留下跟上一層不同的欄位 —— 指派層存這個，之後改系統預設才跟得動 */
function diffFrom(base, full) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (full[k] !== base[k]) out[k] = full[k];
  }
  return out;
}

function safeParse(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * 這一場考試實際要用的考官設定。
 * @param {object} systemCfg  db.getSettings() 裡的 speakingExaminer
 * @param {object|string} assignmentCfg  assignments.examiner（JSON 字串或物件）
 */
function resolve(systemCfg, assignmentCfg) {
  const system = normalize(safeParse(systemCfg) || {}, DEFAULTS);
  const own = safeParse(assignmentCfg);
  return own ? normalize(own, system) : system;
}

/** 人設的那一段指示 */
function personaBlock(ex) {
  const bits = [
    `You are ${ex.name || 'the examiner'}, a certified IELTS Speaking examiner conducting a real`,
    `face-to-face style speaking test in ${ACCENTS[ex.accent].prompt}.`,
  ];
  return `${bits.join(' ')}

- ${PACES[ex.pace].prompt}
- ${STYLES[ex.style].prompt} NEVER give feedback, praise, corrections or scores.
  Never say "good", "well done", "that's interesting".
- Ask ONE question at a time and then STOP and listen. Do not stack questions.
- Short natural acknowledgements are fine ("Right.", "Mm-hm.", "OK.") before the next question.
- ${FOLLOW_UPS[ex.followUps].prompt}
- If the candidate does not understand, you may repeat the question once, but do not rephrase
  Part 2 cue-card content.
- Do NOT talk about being an AI. Do not read out stage directions.
- Keep your own turns short — the candidate should be speaking most of the time.${
  ex.extraInstructions ? `\n\nADDITIONAL INSTRUCTIONS FROM THE SCHOOL (follow these too):\n${ex.extraInstructions}` : ''}`;
}

/** 評分時附加的寬嚴指示 */
function strictnessPrompt(ex) {
  return STRICTNESS[ex.strictness]?.prompt || STRICTNESS.standard.prompt;
}

/** 送給前端的顯示開關 */
function displayFlags(ex) {
  return {
    showLiveScore: ex.showLiveScore,
    showTranscript: ex.showTranscript,
    showPhase: ex.showPhase,
    showCueCard: ex.showCueCard,
    showLevelMeter: ex.showLevelMeter,
  };
}

/** 給設定頁用的選項清單 */
function options() {
  const pick = (t) => Object.entries(t).map(([k, v]) => ({ value: k, label: v.label }));
  return {
    accent: pick(ACCENTS), pace: pick(PACES), style: pick(STYLES),
    followUps: pick(FOLLOW_UPS), strictness: pick(STRICTNESS),
    ranges: NUM_RANGES, defaults: DEFAULTS,
  };
}

module.exports = {
  DEFAULTS, ACCENTS, PACES, STYLES, FOLLOW_UPS, STRICTNESS, NUM_RANGES,
  normalize, resolve, diffFrom, personaBlock, strictnessPrompt, displayFlags, options,
};
