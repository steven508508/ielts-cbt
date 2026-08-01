'use strict';
/**
 * 客觀題答案比對。規則盡量貼近官方：
 *  - 大小寫不計
 *  - 前後空白、重複空白、句尾標點不計
 *  - 標準答案可寫多個（陣列，或用 " / " 分隔）
 *  - 括號內文字視為可有可無： "(the) north gate" → 兩種寫法都算對
 *  - 超過字數限制一律算錯（官方規則）
 *  - 可選擇是否容許英美拼寫差異、連字號與空白互通
 */

const BRITISH_AMERICAN = [
  [/ise\b/g, 'ize'], [/isation\b/g, 'ization'], [/ising\b/g, 'izing'], [/ised\b/g, 'ized'],
  [/yse\b/g, 'yze'], [/our\b/g, 'or'], [/ours\b/g, 'ors'],
  [/([bcdfghjklmnpqrstvwxz])re\b/g, '$1er'],
  [/ogue\b/g, 'og'], [/ll(ing|ed|er)\b/g, 'l$1'],
];

const CONTRACTIONS = [
  [/\bdon't\b/g, 'do not'], [/\bdoesn't\b/g, 'does not'], [/\bcan't\b/g, 'cannot'],
  [/\bwon't\b/g, 'will not'], [/\bit's\b/g, 'it is'], [/\bi'm\b/g, 'i am'],
];

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** 基本正規化 */
function normalize(raw, opts = {}) {
  if (raw == null) return '';
  let s = String(raw);
  s = stripDiacritics(s);
  s = s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  s = s.replace(/[\u00a0\u3000]/g, ' ');
  s = s.trim().toLowerCase();
  s = s.replace(/^["'“”]+|["'“”]+$/g, '');
  s = s.replace(/[.,;:!?]+$/g, '');
  s = s.replace(/\s+/g, ' ');
  if (opts.expandContractions !== false) for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
  if (opts.hyphenEqualsSpace !== false) s = s.replace(/[-–—]/g, ' ').replace(/\s+/g, ' ');
  if (opts.allowSpellingVariants !== false) for (const [re, to] of BRITISH_AMERICAN) s = s.replace(re, to);
  return s.trim();
}

/** 展開括號選擇性文字："(the) north (gate)" → 所有組合 */
function expandOptional(text) {
  const results = [String(text)];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < results.length; i++) {
      const m = results[i].match(/\(([^()]*)\)/);
      if (!m) continue;
      const withIt = results[i].replace(m[0], m[1]);
      const without = results[i].replace(m[0], '');
      results.splice(i, 1, withIt, without);
      changed = true;
      break;
    }
  }
  return [...new Set(results.map((s) => s.replace(/\s+/g, ' ').trim()))];
}

/** 把一個標準答案字串拆成所有可接受寫法 */
function expandAnswer(answer) {
  const parts = String(answer)
    // 答案卷慣例：用 " // "、" | " 或大寫 " OR " 分隔多種寫法
    // （OR 只認大寫，避免把 "gold or silver" 這種正常答案切開）
    .split(/\s*(?:\/\/|\|)\s*|\s+OR\s+/)
    .flatMap((p) => (/[()]/.test(p) ? expandOptional(p) : [p]))
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [String(answer).trim()];
}

function countWords(s) {
  const t = String(s || '').trim();
  if (!t) return 0;
  // 數字加單位視為一個字（官方：a number counts as one word）
  return t.split(/\s+/).filter(Boolean).length;
}

/**
 * 比對單一題。
 * @returns {{correct:boolean, awarded:number, max:number, reason?:string}}
 */
function checkAnswer(question, response, opts = {}) {
  const type = question.type || question.groupType;
  const accepted = (question.answers || []).flatMap(expandAnswer);

  // ── 多選題：一題多個題號，選對一個給一分 ──
  if (type === 'mcq_multi') {
    const want = new Set(accepted.map((a) => a.toUpperCase().trim()));
    const got = new Set(
      String(response || '').split(/[,\s]+/).filter(Boolean).map((x) => x.toUpperCase())
    );
    const max = want.size || 1;
    if (got.size > want.size) {
      return { correct: false, awarded: 0, max, reason: `選了 ${got.size} 個，超過規定的 ${want.size} 個` };
    }
    let awarded = 0;
    for (const g of got) if (want.has(g)) awarded += 1;
    return { correct: awarded === max, awarded, max };
  }

  const max = 1;
  if (response == null || String(response).trim() === '')
    return { correct: false, awarded: 0, max, reason: '未作答' };

  // ── 字母 / 選項題 ──
  if (['mcq_single', 'matching', 'gap_fill_bank'].includes(type)) {
    const got = String(response).trim().toUpperCase().replace(/[.,)]/g, '');
    const ok = accepted.some((a) => a.trim().toUpperCase().replace(/[.,)]/g, '') === got);
    return { correct: ok, awarded: ok ? 1 : 0, max };
  }

  // ── TRUE/FALSE/NOT GIVEN、YES/NO/NOT GIVEN ──
  if (['tfng', 'ynng'].includes(type)) {
    const canon = (v) => String(v).trim().toUpperCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ')
      .replace(/^NG$/, 'NOT GIVEN').replace(/^T$/, 'TRUE').replace(/^F$/, 'FALSE')
      .replace(/^Y$/, 'YES').replace(/^N$/, 'NO');
    const got = canon(response);
    const ok = accepted.some((a) => canon(a) === got);
    return { correct: ok, awarded: ok ? 1 : 0, max };
  }

  // ── 文字填答（含 gap_fill / short_answer / label_image）──
  const limit = question.wordLimit;
  if (limit && countWords(response) > limit)
    return { correct: false, awarded: 0, max, reason: `超過 ${limit} 字上限` };

  // 考生若自己打了括號（例如抄答案卷的 "(the) north gate"），也一併展開比對
  const gotForms = new Set(
    (/[()]/.test(String(response)) ? expandOptional(String(response)) : [String(response)])
      .map((r) => normalize(r, opts))
  );
  const ok = accepted.some((a) => gotForms.has(normalize(a, opts)));
  return { correct: ok, awarded: ok ? 1 : 0, max };
}

module.exports = { normalize, expandAnswer, expandOptional, countWords, checkAnswer };
