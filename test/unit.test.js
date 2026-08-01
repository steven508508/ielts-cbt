'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { normalize, expandAnswer, countWords, checkAnswer } = require('../server/lib/answers');
const bands = require('../server/lib/bands');
const { validatePaper, normalizePaper, flattenQuestions, stripAnswers } = require('../server/lib/paper');
const tabular = require('../server/lib/tabular');

// ── 答案正規化 ────────────────────────────────────────────
test('normalize：忽略大小寫、標點、重音、多餘空白', () => {
  assert.equal(normalize('  Café–Bar. '), 'cafe bar');
  assert.equal(normalize('THE North Gate'), 'the north gate');
  assert.equal(normalize('"answer"'), 'answer');
});

test('normalize：英美拼法互通', () => {
  assert.equal(normalize('colour'), normalize('color'));
  assert.equal(normalize('centre'), normalize('center'));
  assert.equal(normalize('organise'), normalize('organize'));
});

test('expandAnswer：括號代表可有可無', () => {
  const out = expandAnswer('(the) north gate');
  assert.ok(out.includes('the north gate'));
  assert.ok(out.includes('north gate'));
});

test('expandAnswer：大寫 OR 才切開，小寫 or 不切', () => {
  assert.deepEqual(expandAnswer('gold OR silver').sort(), ['gold', 'silver']);
  assert.deepEqual(expandAnswer('gold or silver'), ['gold or silver']);
});

test('countWords：數字與單位', () => {
  assert.equal(countWords('07700 900412'), 2);
  assert.equal(countWords('  two words '), 2);
  assert.equal(countWords(''), 0);
});

// ── 逐題比對 ──────────────────────────────────────────────
test('gap_fill：字數超過上限一律不給分', () => {
  const q = { type: 'gap_fill', answers: ['morning yoga'], wordLimit: 2 };
  assert.equal(checkAnswer(q, 'morning yoga').correct, true);
  assert.equal(checkAnswer(q, 'the morning yoga class').correct, false);
  assert.match(checkAnswer(q, 'the morning yoga class').reason, /上限/);
});

test('gap_fill：接受多個標準答案與大小寫差異', () => {
  const q = { type: 'gap_fill', answers: ['Bradfield', 'Bradfeild'], wordLimit: 1 };
  assert.equal(checkAnswer(q, 'bradfield').correct, true);
  assert.equal(checkAnswer(q, 'BRADFEILD').correct, true);
  assert.equal(checkAnswer(q, 'Bradford').correct, false);
});

test('tfng / ynng：接受簡寫與大小寫', () => {
  const q = { type: 'tfng', answers: ['NOT GIVEN'] };
  assert.equal(checkAnswer(q, 'not given').correct, true);
  assert.equal(checkAnswer(q, 'NG').correct, true);
  assert.equal(checkAnswer(q, 'FALSE').correct, false);
});

test('mcq_single：忽略多餘標點', () => {
  const q = { type: 'mcq_single', answers: ['B'] };
  assert.equal(checkAnswer(q, 'b').correct, true);
  assert.equal(checkAnswer(q, 'B)').correct, true);
  assert.equal(checkAnswer(q, 'C').correct, false);
});

test('mcq_multi：選對一個給一分，超選則零分', () => {
  const q = { type: 'mcq_multi', answers: ['B', 'D'] };
  assert.deepEqual(pick(checkAnswer(q, 'B,D')), { awarded: 2, max: 2 });
  assert.deepEqual(pick(checkAnswer(q, 'B,C')), { awarded: 1, max: 2 });
  assert.deepEqual(pick(checkAnswer(q, 'B,C,D')), { awarded: 0, max: 2 });
  assert.deepEqual(pick(checkAnswer(q, '')), { awarded: 0, max: 2 });
  function pick(r) { return { awarded: r.awarded, max: r.max }; }
});

test('未作答一律零分', () => {
  assert.equal(checkAnswer({ type: 'gap_fill', answers: ['x'] }, '').awarded, 0);
  assert.equal(checkAnswer({ type: 'mcq_single', answers: ['A'] }, null).awarded, 0);
});

// ── 分數換算 ──────────────────────────────────────────────
test('聽力原始分換算', () => {
  assert.equal(bands.rawToBand(40, 40, 'listening'), 9.0);
  assert.equal(bands.rawToBand(30, 40, 'listening'), 7.0);
  assert.equal(bands.rawToBand(23, 40, 'listening'), 6.0);
  assert.equal(bands.rawToBand(0, 40, 'listening'), 0);
});

test('學術與一般組閱讀對照表不同', () => {
  assert.equal(bands.rawToBand(30, 40, 'reading', 'academic'), 7.0);
  assert.equal(bands.rawToBand(30, 40, 'reading', 'general'), 6.0);
});

test('題數不是 40 時等比例換算', () => {
  assert.equal(bands.rawToBand(20, 20, 'listening'), 9.0);
  assert.equal(bands.rawToBand(15, 20, 'listening'), bands.rawToBand(30, 40, 'listening'));
});

test('總分：.25 進到 .5、.75 進到整數', () => {
  assert.equal(bands.overallBand({ listening: 6.5, reading: 6.5, writing: 5.0, speaking: 7.0 }), 6.5);
  assert.equal(bands.overallBand({ listening: 4.0, reading: 3.5, writing: 4.0, speaking: 4.0 }), 4.0);
  assert.equal(bands.overallBand({ listening: 6.0, reading: 6.0, writing: 6.5, speaking: 6.0 }), 6.0);
});

test('四項評分標準平均', () => {
  assert.equal(bands.criteriaToBand({ TA: 6, CC: 7, LR: 6, GRA: 6 }), 6.5);
  assert.equal(bands.criteriaToBand({ TA: 7, CC: 7, LR: 7, GRA: 7 }), 7.0);
});

test('CEFR 對照', () => {
  assert.equal(bands.cefrLevel(8.5), 'C2');
  assert.equal(bands.cefrLevel(7.0), 'C1');
  assert.equal(bands.cefrLevel(5.5), 'B2');
  assert.equal(bands.cefrLevel(4.0), 'B1');
});

// ── 試卷結構 ──────────────────────────────────────────────
const MINI = {
  title: 'mini', testType: 'academic',
  modules: [{
    module: 'reading',
    sections: [{
      title: 'P1', passage: '<p>text</p>',
      groups: [
        { type: 'tfng', instructions: 'x', questions: [{ number: 1, text: 'a', answers: ['TRUE'] }] },
        {
          type: 'gap_fill', wordLimit: 2, bodyHtml: 'Name: [[2]] and [[3]]',
          questions: [{ number: 2, answers: ['x'] }, { number: 3, answers: ['y'] }],
        },
      ],
    }],
  }],
};

test('validatePaper：正確的試卷通過', () => {
  const r = validatePaper(MINI);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.stats.reading, 3);
});

test('validatePaper：bodyHtml 空格與題號不符要報錯', () => {
  const bad = JSON.parse(JSON.stringify(MINI));
  bad.modules[0].sections[0].groups[1].bodyHtml = 'Name: [[2]]';
  const r = validatePaper(bad);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /缺少空格/);
});

test('validatePaper：沒有標準答案要報錯', () => {
  const bad = JSON.parse(JSON.stringify(MINI));
  bad.modules[0].sections[0].groups[0].questions[0].answers = [];
  assert.match(validatePaper(bad).errors.join(' '), /沒有標準答案/);
});

test('validatePaper：TFNG 答案值必須合法', () => {
  const bad = JSON.parse(JSON.stringify(MINI));
  bad.modules[0].sections[0].groups[0].questions[0].answers = ['MAYBE'];
  assert.match(validatePaper(bad).errors.join(' '), /TRUE/);
});

test('validatePaper：題號重複要報錯', () => {
  const bad = JSON.parse(JSON.stringify(MINI));
  bad.modules[0].sections[0].groups[1].questions[1].number = 2;
  bad.modules[0].sections[0].groups[1].bodyHtml = 'Name: [[2]]';
  assert.match(validatePaper(bad).errors.join(' '), /重複/);
});

test('validatePaper：未知題型要報錯', () => {
  const bad = JSON.parse(JSON.stringify(MINI));
  bad.modules[0].sections[0].groups[0].type = 'nope';
  assert.match(validatePaper(bad).errors.join(' '), /未知題型/);
});

test('stripAnswers：學生版看不到答案與解析', () => {
  const safe = stripAnswers(normalizePaper(MINI));
  const q = safe.modules[0].sections[0].groups[0].questions[0];
  assert.equal(q.answers, undefined);
  assert.equal(q.explanation, undefined);
  assert.equal(q.number, 1);
});

test('flattenQuestions：依題號排序並帶出題型', () => {
  const qs = flattenQuestions(normalizePaper(MINI), 'reading');
  assert.deepEqual(qs.map((q) => q.number), [1, 2, 3]);
  assert.equal(qs[1].type, 'gap_fill');
  assert.equal(qs[1].wordLimit, 2);
});

test('每題可以有自己的選項', () => {
  const p = normalizePaper({
    title: 't', modules: [{ module: 'reading', sections: [{ title: 's', groups: [{
      type: 'mcq_single',
      questions: [
        { number: 1, text: 'a', options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }], answers: ['B'] },
        { number: 2, text: 'b', options: [{ key: 'A', text: 'p' }, { key: 'B', text: 'q' }], answers: ['A'] },
      ],
    }] }] }],
  });
  const r = validatePaper(p);
  assert.equal(r.ok, true, r.errors.join('; '));
  const qs = flattenQuestions(r.paper, 'reading');
  assert.equal(qs[0].options[1].text, 'y');
  assert.equal(qs[1].options[1].text, 'q');
});

// ── 表格匯入 ──────────────────────────────────────────────
test('Excel 範本可以被自己讀回來並轉成合法試卷', () => {
  const buf = tabular.buildTemplate();
  const rows = tabular.readRows(buf, 'template.xlsx');
  assert.ok(rows.length >= 8, `只讀到 ${rows.length} 列`);
  const { paper } = tabular.rowsToPaper(rows, { title: 't', testType: 'academic' });
  const r = validatePaper(paper);
  assert.equal(r.stats.writingTasks, 2);
  assert.equal(r.stats.speakingParts, 1);
  assert.ok(r.stats.listening >= 3);
});

test('選項字串解析', () => {
  assert.deepEqual(tabular.parseOptions('A. one || B. two'), [
    { key: 'A', text: 'one' }, { key: 'B', text: 'two' },
  ]);
  assert.deepEqual(tabular.parseAnswers('Bradfield // Bradfeild'), ['Bradfield', 'Bradfeild']);
});

// ── 內建範例試卷 ──────────────────────────────────────────
test('內建範例試卷完全合法', () => {
  const paper = require('../samples/full-paper-academic.json');
  const r = validatePaper(paper);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.stats.listening, 40);
  assert.equal(r.stats.reading, 40);
  assert.equal(r.stats.writingTasks, 2);
});

test('題型範本檔完全合法', () => {
  const paper = require('../samples/question-type-reference.json');
  const r = validatePaper(paper);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('照答案卷作答可以拿滿分', () => {
  const paper = require('../samples/full-paper-academic.json');
  for (const mod of ['listening', 'reading']) {
    const qs = flattenQuestions(normalizePaper(paper), mod);
    let score = 0, total = 0;
    for (const q of qs) {
      const r = checkAnswer(q, q.answers[0]);
      total += 1;
      score += q.type === 'mcq_multi' ? (r.awarded > 0 ? 1 : 0) : r.awarded;
    }
    assert.equal(score, total, `${mod} 只拿到 ${score}/${total}`);
  }
});
