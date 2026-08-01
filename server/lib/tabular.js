'use strict';
/**
 * Excel / CSV 匯入。
 *
 * 一列 = 一題（或一個題組的設定列）。欄位名稱不分大小寫，底線與空白皆可。
 *
 * ┌ 欄位 ───────────┬ 說明 ────────────────────────────────────────────┐
 * │ module          │ listening / reading / writing / speaking          │
 * │ section         │ 第幾個 section（數字）或標題文字                  │
 * │ section_title   │ section 顯示名稱（選填）                          │
 * │ audio           │ 聽力音檔網址，例如 /uploads/audio/s1.mp3          │
 * │ passage_title   │ 閱讀文章標題                                      │
 * │ passage         │ 閱讀文章內容（同一 section 只需填一次）           │
 * │ transcript      │ 聽力逐字稿（選填，檢討時顯示）                    │
 * │ group           │ 題組編號，同一組填一樣的值                        │
 * │ type            │ 題型代碼（mcq_single / tfng / gap_fill …）        │
 * │ instructions    │ 題組指示語（同一組只需填一次）                    │
 * │ word_limit      │ 填空題字數上限                                    │
 * │ options         │ 選項，用 || 分隔，例如  A. 文字 || B. 文字        │
 * │ body_html       │ 填空題版面，用 [[題號]] 標示空格                  │
 * │ image           │ 圖片網址（地圖/圖表題）                           │
 * │ number          │ 題號（writing 填 task 編號、speaking 填 part）    │
 * │ question        │ 題目敘述                                          │
 * │ answer          │ 標準答案，多種寫法用 // 分隔                      │
 * │ explanation     │ 解析                                              │
 * │ select_count    │ 多選題要選幾個                                    │
 * └─────────────────┴──────────────────────────────────────────────────┘
 */
const XLSX = require('xlsx');

const HEADER_ALIASES = {
  module: 'module', 科目: 'module', 項目: 'module',
  section: 'section', 段落: 'section',
  section_title: 'sectionTitle', sectiontitle: 'sectionTitle', 段落標題: 'sectionTitle',
  audio: 'audio', 音檔: 'audio',
  passage_title: 'passageTitle', passagetitle: 'passageTitle', 文章標題: 'passageTitle',
  passage: 'passage', 文章: 'passage',
  transcript: 'transcript', 逐字稿: 'transcript',
  group: 'group', 題組: 'group',
  type: 'type', 題型: 'type',
  instructions: 'instructions', instruction: 'instructions', 指示: 'instructions', 說明: 'instructions',
  word_limit: 'wordLimit', wordlimit: 'wordLimit', 字數上限: 'wordLimit',
  options: 'options', 選項: 'options',
  body_html: 'bodyHtml', bodyhtml: 'bodyHtml', body: 'bodyHtml', 版面: 'bodyHtml',
  image: 'image', 圖片: 'image',
  number: 'number', no: 'number', 題號: 'number',
  question: 'question', stem: 'question', 題目: 'question',
  answer: 'answer', answers: 'answer', 答案: 'answer',
  explanation: 'explanation', 解析: 'explanation',
  select_count: 'selectCount', selectcount: 'selectCount', 選幾個: 'selectCount',
  min_words: 'minWords', minwords: 'minWords', 最少字數: 'minWords',
  duration_sec: 'durationSec', durationsec: 'durationSec', 時間秒: 'durationSec',
};

function canonHeader(h) {
  const k = String(h || '').trim().toLowerCase().replace(/\s+/g, '_');
  return HEADER_ALIASES[k] || HEADER_ALIASES[k.replace(/_/g, '')] || null;
}

function parseOptions(text) {
  if (!text) return null;
  const chunks = String(text)
    .split(/\s*\|\|\s*|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chunks.length) return null;
  return chunks.map((c, i) => {
    const m = c.match(/^([A-Za-z]|[ivxIVX]+)\s*[.)、:：]\s*(.+)$/);
    return m
      ? { key: m[1].trim(), text: m[2].trim() }
      : { key: String.fromCharCode(65 + i), text: c };
  });
}

function splitList(text) {
  return String(text || '')
    .split(/\s*\|\|\s*|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseAnswers(text) {
  if (text == null || text === '') return [];
  return String(text)
    .split(/\s*(?:\/\/|;|；)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 讀出所有列（陣列的物件），支援 xlsx / xls / csv */
function readRows(buffer, filename = '') {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const rows = [];
  for (const sheetName of wb.SheetNames) {
    if (/^說明|readme|instructions$/i.test(sheetName)) continue;
    const sheet = wb.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    if (!raw.length) continue;
    const headers = raw[0].map(canonHeader);
    if (!headers.some((h) => h === 'type' || h === 'module')) continue;
    for (let i = 1; i < raw.length; i++) {
      const obj = {};
      let any = false;
      raw[i].forEach((cell, ci) => {
        const key = headers[ci];
        if (!key) return;
        const v = typeof cell === 'string' ? cell.trim() : cell;
        if (v !== '' && v != null) any = true;
        obj[key] = v;
      });
      if (any) rows.push(obj);
    }
  }
  return rows;
}

/** 把列資料轉成試卷 JSON */
function rowsToPaper(rows, meta = {}) {
  const notes = [];
  const paper = {
    title: meta.title || '匯入的試卷',
    testType: meta.testType === 'general' ? 'general' : 'academic',
    description: meta.description || '',
    modules: [],
  };

  const modOrder = ['listening', 'reading', 'writing', 'speaking'];
  const modMap = new Map();
  let lastModule = null;
  let lastSectionKey = null;

  for (const [ri, row] of rows.entries()) {
    const moduleName = String(row.module || lastModule || '').trim().toLowerCase();
    if (!modOrder.includes(moduleName)) {
      notes.push(`第 ${ri + 2} 列：無法辨識的 module "${row.module}"，已略過`);
      continue;
    }
    lastModule = moduleName;

    if (!modMap.has(moduleName)) modMap.set(moduleName, { module: moduleName, sections: new Map() });
    const mod = modMap.get(moduleName);

    const sectionKey = String(row.section ?? '').trim() || lastSectionKey || '1';
    lastSectionKey = sectionKey;
    if (!mod.sections.has(sectionKey)) {
      mod.sections.set(sectionKey, {
        title: row.sectionTitle || (moduleName === 'reading' ? `Reading Passage ${sectionKey}` : `Section ${sectionKey}`),
        groups: new Map(),
      });
    }
    const sec = mod.sections.get(sectionKey);
    if (row.sectionTitle) sec.title = row.sectionTitle;
    if (row.audio) sec.audio = row.audio;
    if (row.passage) sec.passage = /<\w+/.test(row.passage) ? row.passage : `<p>${String(row.passage).split(/\n{2,}/).join('</p><p>')}</p>`;
    if (row.passageTitle) sec.passageTitle = row.passageTitle;
    if (row.transcript) sec.transcript = row.transcript;

    const type = String(row.type || '').trim();
    if (!type) continue;

    const groupKey = `${type}#${String(row.group ?? '').trim() || 'default'}`;
    if (!sec.groups.has(groupKey)) sec.groups.set(groupKey, { type, questions: [] });
    const g = sec.groups.get(groupKey);
    if (row.instructions) g.instructions = row.instructions;
    if (row.wordLimit) g.wordLimit = Number(row.wordLimit) || null;
    if (row.image) g.image = row.image;
    if (row.bodyHtml && type !== 'speaking_part') g.bodyHtml = row.bodyHtml;
    if (row.selectCount) g.selectCount = Number(row.selectCount) || null;

    // 單選題每一題的選項都不一樣 → 掛在題目上；配對／選字填空是整組共用 → 掛在題組上
    const perQuestionOptions = type === 'mcq_single';
    let rowOptions = row.options ? parseOptions(row.options) : null;
    if (rowOptions && !perQuestionOptions) { g.options = rowOptions; rowOptions = null; }

    // ── 寫作 ──
    if (type === 'writing_task') {
      g.questions.push({
        number: Number(row.number) || g.questions.length + 1,
        taskNo: Number(row.number) || g.questions.length + 1,
        prompt: row.question || '',
        image: row.image || null,
        minWords: Number(row.minWords) || (Number(row.number) === 2 ? 250 : 150),
        durationSec: Number(row.durationSec) || (Number(row.number) === 2 ? 2400 : 1200),
        sampleAnswer: row.explanation || '',
      });
      continue;
    }

    // ── 口說 ──
    if (type === 'speaking_part') {
      const part = Number(row.number) || 1;
      if (part === 2) {
        g.questions.push({
          part: 2,
          cueCard: {
            topic: row.question || '',
            bullets: splitList(row.bodyHtml),
            prepSec: Number(row.durationSec) || 60,
            talkSec: 120,
          },
          rounding: splitList(row.explanation),
        });
      } else {
        g.questions.push({
          part,
          topic: row.question || '',
          items: splitList(row.bodyHtml).length ? splitList(row.bodyHtml) : (row.question ? [row.question] : []),
        });
      }
      continue;
    }

    // ── 客觀題 ──
    g.questions.push({
      number: Number(row.number) || null,
      text: row.question || '',
      answers: parseAnswers(row.answer),
      explanation: row.explanation || '',
      ...(rowOptions ? { options: rowOptions } : {}),
    });
  }

  for (const name of modOrder) {
    const mod = modMap.get(name);
    if (!mod) continue;
    paper.modules.push({
      module: name,
      sections: [...mod.sections.values()].map((s) => ({
        title: s.title,
        audio: s.audio,
        passage: s.passage,
        passageTitle: s.passageTitle,
        transcript: s.transcript,
        groups: [...s.groups.values()],
      })),
    });
  }

  return { paper, notes };
}

/** 產生空白範本（回傳 xlsx Buffer） */
function buildTemplate() {
  const headers = [
    'module', 'section', 'section_title', 'audio', 'passage_title', 'passage', 'transcript',
    'group', 'type', 'instructions', 'word_limit', 'options', 'body_html', 'image',
    'number', 'question', 'answer', 'explanation', 'select_count', 'min_words', 'duration_sec',
  ];
  const sample = [
    { module: 'listening', section: 1, section_title: 'Section 1', audio: '/uploads/audio/section1.mp3',
      group: 1, type: 'gap_fill',
      instructions: 'Complete the form below. Write NO MORE THAN TWO WORDS AND/OR A NUMBER for each answer.',
      word_limit: 2, body_html: '<h4>Rental Enquiry</h4><p>Name: [[1]]<br>Phone: [[2]]</p>',
      number: 1, question: '', answer: 'Bradfield // Bradfeild', explanation: '對話中拼出 B-R-A-D-F-I-E-L-D' },
    { module: 'listening', section: 1, group: 1, type: 'gap_fill', number: 2, answer: '07700 900412' },
    { module: 'listening', section: 2, section_title: 'Section 2', audio: '/uploads/audio/section2.mp3',
      group: 2, type: 'mcq_single', instructions: 'Choose the correct letter, A, B or C.',
      options: 'A. by bus || B. on foot || C. by bicycle',
      number: 11, question: 'How do most visitors arrive?', answer: 'B' },
    { module: 'reading', section: 1, section_title: 'Reading Passage 1', passage_title: 'The Urban Beehive',
      passage: 'Paragraph one text…\n\nParagraph two text…',
      group: 1, type: 'tfng',
      instructions: 'Do the following statements agree with the information given in the passage?',
      number: 1, question: 'Urban hives produce more honey than rural hives.', answer: 'FALSE' },
    { module: 'writing', section: 1, group: 1, type: 'writing_task', number: 1, min_words: 150, duration_sec: 1200,
      question: 'The chart below shows… Summarise the information by selecting and reporting the main features.',
      image: '/uploads/image/task1-chart.png' },
    { module: 'writing', section: 1, group: 1, type: 'writing_task', number: 2, min_words: 250, duration_sec: 2400,
      question: 'Some people believe… Discuss both views and give your own opinion.' },
    { module: 'speaking', section: 1, group: 1, type: 'speaking_part', number: 1, question: 'Hometown',
      body_html: 'Where is your hometown? || What do you like about it? || Has it changed much? || Would you like to live there in the future?' },
    { module: 'speaking', section: 1, group: 1, type: 'speaking_part', number: 2,
      question: 'Describe a skill you learned that was difficult at first.',
      body_html: 'what the skill was || how you learned it || why it was difficult || and explain how you feel about it now',
      duration_sec: 60 },
    { module: 'speaking', section: 1, group: 1, type: 'speaking_part', number: 3, question: 'Learning and society',
      body_html: 'Why do some people give up easily? || Should schools teach practical skills? || How has technology changed the way we learn?' },
  ];

  const ws = XLSX.utils.json_to_sheet(sample, { header: headers });
  ws['!cols'] = headers.map((h) => ({ wch: ['passage', 'question', 'body_html', 'instructions', 'options'].includes(h) ? 42 : 16 }));

  const readme = XLSX.utils.aoa_to_sheet([
    ['IELTS 題目匯入範本 — 使用說明'],
    [],
    ['1. 「題目」分頁裡一列 = 一題。同一個題組（同一段指示語、同一組選項）請填相同的 group 值。'],
    ['2. 指示語 instructions、選項 options、版面 body_html 只需要在該題組的第一列填寫。'],
    ['3. 選項用 || 分隔，例如：A. 文字 || B. 文字 || C. 文字'],
    ['4. 答案有多種寫法時用 // 分隔，例如：Bradfield // Bradfeild'],
    ['5. 括號代表可有可無，例如：(the) north gate  兩種寫法都算對。'],
    ['6. 填空題請把版面寫在 body_html，用 [[題號]] 當作空格，例如：Name: [[1]]'],
    ['7. 音檔與圖片請先到「媒體庫」上傳，再把系統給的網址貼到 audio / image 欄。'],
    [],
    ['可用題型代碼：'],
    ['mcq_single', '單選題'],
    ['mcq_multi', '多選題（配合 select_count）'],
    ['tfng', 'TRUE / FALSE / NOT GIVEN'],
    ['ynng', 'YES / NO / NOT GIVEN'],
    ['matching', '配對題（含配標題、配段落、配特徵、配句尾）'],
    ['gap_fill', '填空（表格/筆記/摘要/句子/流程圖/圖表標示）'],
    ['gap_fill_bank', '填空（從選項清單挑）'],
    ['short_answer', '簡答題'],
    ['label_image', '地圖／平面圖／圖表標示'],
    ['writing_task', '寫作題（number 填 1 或 2）'],
    ['speaking_part', '口說（number 填 1、2、3）'],
  ]);
  readme['!cols'] = [{ wch: 22 }, { wch: 60 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, readme, '說明');
  XLSX.utils.book_append_sheet(wb, ws, '題目');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { readRows, rowsToPaper, buildTemplate, parseOptions, parseAnswers, splitList };
