'use strict';
/**
 * 出題難度。
 *
 * 「Band 6-7」對 AI 來說幾乎沒有意義 —— 你叫它出 band 5-6，它照樣寫出
 * 一篇 1000 字的學術文章配三題 NOT GIVEN。真正決定難度的是幾件具體的事：
 * 文章多長、句子多繞、生難字多少、推論題佔多少、聽力講多快。
 *
 * 所以這裡把「目標 Band」翻譯成這四件事的具體指令，再塞進出題提示。
 * 老師可以只選一個 Band 就好，也可以個別把某一項再往上下調。
 */

/** 四個可微調的面向。每一個都有 3 檔，預設跟著 Band 走。 */
const KNOBS = {
  text: {
    label: '文本長度與句構',
    zh: '文章／逐字稿寫多長、句子繞不繞',
    options: {
      auto: { label: '跟隨難度' },
      short: {
        label: '簡短好讀',
        zh: '短、句子單純',
        en: 'Keep texts SHORT and syntactically simple: mostly single-clause and simple two-clause sentences, '
          + 'concrete subjects, few nominalisations, no long embedded relative clauses. Aim for the lower end of the word range.',
      },
      standard: {
        label: '標準',
        zh: '官方常見長度',
        en: 'Use the sentence complexity of a typical official paper: a natural mix of simple, compound and complex sentences.',
      },
      dense: {
        label: '長而複雜',
        zh: '長、多子句、抽象',
        en: 'Write DENSE academic prose: multi-clause sentences with embedded relatives and participle phrases, '
          + 'heavy nominalisation, abstract subjects, and information packed such that careless readers lose the thread. '
          + 'Aim for the upper end of the word range.',
      },
    },
  },
  hardTypes: {
    label: '難題型比例',
    zh: 'NOT GIVEN、Matching Headings 這類推論題要放多少',
    options: {
      auto: { label: '跟隨難度' },
      few: {
        label: '少',
        zh: '以填空、單選為主',
        en: 'Favour LOW-inference task types: sentence/note/table/summary completion, short answer, and straightforward '
          + 'multiple choice where the answer is stated almost verbatim. Use at most one inference-heavy group per section.',
      },
      standard: {
        label: '標準',
        zh: '照官方的混合比例',
        en: 'Use the task-type mix of a typical official paper.',
      },
      many: {
        label: '多',
        zh: '推論題、細節辨析題偏多',
        en: 'Load the paper with HIGH-inference task types: True/False/Not Given, Yes/No/Not Given, Matching Headings, '
          + 'Matching Features, and multiple choice whose options are close paraphrases of each other. '
          + 'Not Given items must be genuinely not stated, never merely contradicted.',
      },
    },
  },
  vocab: {
    label: '詞彙難度',
    zh: '學術詞、低頻詞、片語的比例',
    options: {
      auto: { label: '跟隨難度' },
      common: {
        label: '常用字為主',
        zh: '用字限常用 3000 字',
        en: 'Stay within high-frequency everyday vocabulary (roughly the first 3000 word families). '
          + 'Where a technical term is unavoidable, gloss it in the text.',
      },
      standard: { label: '標準', zh: '用字官方標準', en: 'Use the lexical range of a typical official paper.' },
      academic: {
        label: '學術低頻詞多',
        zh: '用字含學術低頻詞、片語',
        en: 'Use a wide lexical range: Academic Word List items, lower-frequency synonyms, idiomatic collocations '
          + 'and phrasal verbs. Questions should require the candidate to recognise paraphrase rather than word matching.',
      },
    },
  },
  listening: {
    label: '聽力語速與口音',
    zh: '講多快、幾種口音、干擾多不多',
    options: {
      auto: { label: '跟隨難度' },
      slow: {
        label: '慢、標準口音',
        zh: '約 120 wpm、單一標準英國腔',
        en: 'Speakers talk at roughly 120 words per minute in standard southern British English. '
          + 'Keep hesitation and self-correction light, and let answers stand out clearly from the surrounding speech.',
      },
      standard: {
        label: '標準',
        zh: '約 140 wpm、英澳為主',
        en: 'Speakers talk at roughly 140 words per minute, mainly British with one Australian or New Zealand speaker, '
          + 'with the natural hesitation and self-correction of the real test.',
      },
      fast: {
        label: '快、多口音',
        zh: '約 160 wpm、英澳加紐、干擾狡猾',
        en: 'Speakers talk at roughly 160 words per minute across a mix of British, Australian, Canadian and Scottish accents. '
          + 'Include overlapping speech, false starts, and distractors where a speaker states a value and then corrects it — '
          + 'the careless listener should write down the first, wrong value.',
      },
    },
  },
};

/**
 * 目標 Band → 每一個面向的預設檔位，以及各科的具體數字。
 * words 是文章／逐字稿的字數範圍，AI 對數字比對形容詞聽話得多。
 */
const LEVELS = {
  'band 4-5': {
    label: 'Band 4–5',
    zh: '初學：短文章、常用字、幾乎沒有推論題',
    defaults: { text: 'short', hardTypes: 'few', vocab: 'common', listening: 'slow' },
    words: { reading: [500, 650], readingGeneral: [400, 550], listening: [500, 650] },
    note_en: 'Target candidates who are still building basic comprehension. Answers should be findable on a first careful read.',
  },
  'band 5-6': {
    label: 'Band 5–6',
    zh: '基礎：偏短文章、常用字為主、少量推論題',
    defaults: { text: 'short', hardTypes: 'few', vocab: 'common', listening: 'slow' },
    words: { reading: [650, 800], readingGeneral: [500, 650], listening: [600, 750] },
    note_en: 'Target candidates around CEFR B1. Paraphrase between question and text should be light and transparent.',
  },
  'band 6-7': {
    label: 'Band 6–7',
    zh: '標準：官方一般難度',
    defaults: { text: 'standard', hardTypes: 'standard', vocab: 'standard', listening: 'standard' },
    words: { reading: [800, 950], readingGeneral: [650, 800], listening: [750, 900] },
    note_en: 'Match the difficulty of a typical official paper.',
  },
  'band 7-8': {
    label: 'Band 7–8',
    zh: '進階：長文章、學術詞彙、推論題偏多',
    defaults: { text: 'dense', hardTypes: 'many', vocab: 'academic', listening: 'fast' },
    words: { reading: [950, 1100], readingGeneral: [800, 950], listening: [850, 1000] },
    note_en: 'Target strong candidates. Every question should require paraphrase recognition rather than word matching.',
  },
  'band 8-9': {
    label: 'Band 8–9',
    zh: '最難：接近官方最難的那一篇，適合衝刺班',
    defaults: { text: 'dense', hardTypes: 'many', vocab: 'academic', listening: 'fast' },
    words: { reading: [1050, 1200], readingGeneral: [900, 1050], listening: [900, 1100] },
    note_en: 'Target near-native candidates. Use the difficulty of the hardest passage in an official paper throughout, '
      + 'with fine-grained distinctions between distractors.',
  },
};

const DEFAULT_LEVEL = 'band 6-7';
const MODULES = ['listening', 'reading', 'writing', 'speaking'];

function levelOf(name) {
  return LEVELS[String(name || '').toLowerCase()] || LEVELS[DEFAULT_LEVEL];
}

/**
 * 把老師的設定攤平成「每一科各自的完整規格」。
 * @param {object} input
 * @param {string} input.level        整體難度
 * @param {object} input.perModule    { reading: 'band 7-8', … } 沒填 = 跟隨整體
 * @param {object} input.knobs        { text:'auto'|'short'…, hardTypes, vocab, listening }
 */
function resolve(input = {}) {
  const levelName = LEVELS[String(input.level || '').toLowerCase()] ? String(input.level).toLowerCase() : DEFAULT_LEVEL;
  const knobs = {};
  for (const k of Object.keys(KNOBS)) {
    const v = String(input.knobs?.[k] || 'auto');
    knobs[k] = KNOBS[k].options[v] ? v : 'auto';
  }

  const out = { level: levelName, knobs, modules: {} };
  for (const m of MODULES) {
    const raw = input.perModule?.[m];
    const name = LEVELS[String(raw || '').toLowerCase()] ? String(raw).toLowerCase() : levelName;
    const lv = LEVELS[name];
    const picked = {};
    for (const k of Object.keys(KNOBS)) {
      picked[k] = knobs[k] === 'auto' ? lv.defaults[k] : knobs[k];
    }
    out.modules[m] = { level: name, label: lv.label, knobs: picked, overridden: name !== levelName };
  }
  return out;
}

/**
 * 產生要塞進出題提示的英文指令。
 * @param {string} module
 * @param {object} spec    resolve() 的結果
 * @param {object} o
 * @param {string} o.testType
 */
function promptFor(module, spec, { testType = 'academic' } = {}) {
  const m = spec?.modules?.[module];
  if (!m) return '';
  const lv = LEVELS[m.level];
  const lines = [`TARGET DIFFICULTY: ${lv.label} (IELTS band). ${lv.note_en}`];

  if (module === 'reading') {
    const range = testType === 'general' ? lv.words.readingGeneral : lv.words.reading;
    lines.push(`Passage length: ${range[0]}-${range[1]} words.`);
    lines.push(KNOBS.text.options[m.knobs.text].en);
    lines.push(KNOBS.vocab.options[m.knobs.vocab].en);
    lines.push(KNOBS.hardTypes.options[m.knobs.hardTypes].en);
  } else if (module === 'listening') {
    lines.push(`Transcript length: ${lv.words.listening[0]}-${lv.words.listening[1]} words.`);
    lines.push(KNOBS.listening.options[m.knobs.listening].en);
    lines.push(KNOBS.vocab.options[m.knobs.vocab].en);
    lines.push(KNOBS.hardTypes.options[m.knobs.hardTypes].en);
  } else if (module === 'writing') {
    lines.push(KNOBS.vocab.options[m.knobs.vocab].en);
    lines.push(m.knobs.text === 'dense'
      ? 'Task 2 should pose an abstract, two-part or evaluative question that is hard to answer without a clear position and concessive argument.'
      : m.knobs.text === 'short'
        ? 'Task 2 should pose a concrete, familiar question that a candidate can answer from everyday experience.'
        : 'Task 2 should pose a question of typical official difficulty.');
    lines.push(m.knobs.text === 'dense'
      ? (testType === 'general'
        ? 'Task 1 should require a letter handling a delicate or complex situation (complaint plus request for compensation, negotiating a change).'
        : 'Task 1 should present a visual with several variables, a time series plus a category breakdown, or a multi-stage process.')
      : m.knobs.text === 'short'
        ? (testType === 'general'
          ? 'Task 1 should require a simple, single-purpose letter.'
          : 'Task 1 should present a single simple chart with a clear trend.')
        : 'Task 1 should be of typical official complexity.');
  } else if (module === 'speaking') {
    lines.push(KNOBS.vocab.options[m.knobs.vocab].en);
    lines.push(m.knobs.hardTypes === 'many'
      ? 'Part 3 questions should be genuinely abstract and evaluative, requiring the candidate to weigh competing considerations, speculate about the future, and justify a position.'
      : m.knobs.hardTypes === 'few'
        ? 'Keep Part 1 and Part 3 questions concrete and personal; Part 3 may ask for opinions but should not require abstract theorising.'
        : 'Use the abstraction level of a typical official Part 3.');
  }

  return lines.filter(Boolean).join('\n');
}

/** 給前端看的中文說明：「你現在這個設定實際上會出什麼」 */
function describe(spec, { testType = 'academic' } = {}) {
  const out = {};
  for (const m of MODULES) {
    const s = spec.modules[m];
    const lv = LEVELS[s.level];
    const bits = [lv.label];
    if (m === 'reading') {
      const r = testType === 'general' ? lv.words.readingGeneral : lv.words.reading;
      bits.push(`文章 ${r[0]}–${r[1]} 字`);
      bits.push(KNOBS.text.options[s.knobs.text].zh);
      bits.push(KNOBS.vocab.options[s.knobs.vocab].zh);
      bits.push(`難題型${KNOBS.hardTypes.options[s.knobs.hardTypes].label}`);
    } else if (m === 'listening') {
      bits.push(`逐字稿 ${lv.words.listening[0]}–${lv.words.listening[1]} 字`);
      bits.push(KNOBS.listening.options[s.knobs.listening].zh);
      bits.push(`難題型${KNOBS.hardTypes.options[s.knobs.hardTypes].label}`);
    } else {
      bits.push(KNOBS.vocab.options[s.knobs.vocab].zh);
      bits.push(s.knobs.hardTypes === 'many' ? '題目偏抽象'
        : s.knobs.hardTypes === 'few' ? '題目偏具體' : '抽象程度標準');
    }
    out[m] = bits.filter(Boolean).join('　·　');
  }
  return out;
}

/** 存進題庫時用的難度標籤 */
function tagFor(spec, module) {
  return spec?.modules?.[module]?.level || spec?.level || DEFAULT_LEVEL;
}

module.exports = {
  LEVELS, KNOBS, MODULES, DEFAULT_LEVEL,
  resolve, promptFor, describe, tagFor, levelOf,
};
