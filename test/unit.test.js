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

// ── async route handler 的錯誤要接得住 ─────────────────────────
// Express 4 只接得住同步 throw。沒有包裝的話，async handler 一旦 reject，
// 伺服器不會回應也不會報錯，瀏覽器就一直轉圈 —— 這種故障最難查。
test('會 reject 的 async route 回 500，不會把請求掛住', async () => {
  const express = require('express');
  const { wrapRouter } = require('../server/middleware/asyncRoutes');

  const r = express.Router();
  r.get('/boom', async () => { throw new Error('故意炸掉'); });
  r.get('/sync-boom', () => { throw new Error('同步炸掉'); });
  r.get('/fine', (req, res) => res.json({ ok: true }));

  const app = express();
  app.use('/t', wrapRouter(r));
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;

  const get = async (p) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(base + p, { signal: ctrl.signal });
      return { status: res.status, body: await res.json() };
    } finally { clearTimeout(timer); }
  };

  try {
    assert.equal((await get('/t/fine')).status, 200, '正常的 route 不受影響');

    const boom = await get('/t/boom');
    assert.equal(boom.status, 500, 'async 例外要變成 500，而不是一直沒有回應');
    assert.equal(boom.body.error, '故意炸掉', '錯誤訊息要傳到錯誤處理中介層');

    const sync = await get('/t/sync-boom');
    assert.equal(sync.status, 500, '同步例外照樣是 500');
    assert.equal(sync.body.error, '同步炸掉');
  } finally {
    srv.close();
  }
});

test('wrapRouter 不會去動錯誤處理中介層', () => {
  const { wrap } = require('../server/middleware/asyncRoutes');
  const errMw = (err, req, res, next) => next(err);
  assert.equal(wrap(errMw), errMw, '四個參數的中介層要原封不動');
  const normal = (req, res, next) => next();
  const once = wrap(normal);
  assert.notEqual(once, normal, '一般中介層要被包起來');
  assert.equal(wrap(once), once, '已經包過的不會再包一層');
});

// ── 速率限制 ───────────────────────────────────────────────────
// 舊版把 req.body.username 放進計數 key，等於「每換一個帳號就重新給
// 一整份額度」——拿一份學生名單就能無限次嘗試密碼。
test('速率限制不會因為換帳號就重新給額度', () => {
  const { rateLimit, _clear } = require('../server/middleware/rateLimit');
  _clear();
  const mw = rateLimit({ key: 't1', windowMs: 60_000, max: 3 });
  const run = (username) => {
    const req = { ip: '1.2.3.4', body: { username } };
    let status = 200;
    const res = { setHeader() {}, status(s) { status = s; return this; }, json() { return this; } };
    let passed = false;
    mw(req, res, () => { passed = true; });
    return { status, passed };
  };
  assert.equal(run('alice').passed, true, '第 1 次放行');
  assert.equal(run('bob').passed, true, '第 2 次放行');
  assert.equal(run('carol').passed, true, '第 3 次放行');
  const fourth = run('dave');
  assert.equal(fourth.passed, false, '第 4 次要被擋下，即使換了帳號');
  assert.equal(fourth.status, 429);
});

test('速率限制可以依使用者計數（已登入的端點用）', () => {
  const { rateLimit, _clear } = require('../server/middleware/rateLimit');
  _clear();
  const mw = rateLimit({ key: 't2', by: 'user', windowMs: 60_000, max: 2 });
  const run = (uid) => {
    const req = { ip: '1.2.3.4', user: { id: uid }, body: {} };
    const res = { setHeader() {}, status() { return this; }, json() { return this; } };
    let passed = false;
    mw(req, res, () => { passed = true; });
    return passed;
  };
  assert.equal(run(1), true);
  assert.equal(run(1), true);
  assert.equal(run(1), false, '同一個使用者第 3 次被擋');
  assert.equal(run(2), true, '不同使用者有自己的額度（同一個 IP 也一樣）');
});

test('速率限制的計數表不會無限成長', () => {
  const { rateLimit, _clear, MAX_BUCKETS } = require('../server/middleware/rateLimit');
  _clear();
  const mw = rateLimit({ key: 't3', windowMs: 60_000, max: 1000 });
  const res = { setHeader() {}, status() { return this; }, json() { return this; } };
  for (let i = 0; i < 50; i += 1) mw({ ip: `10.0.0.${i}`, body: {} }, res, () => {});
  assert.ok(MAX_BUCKETS > 0 && MAX_BUCKETS <= 100_000, '有設上限');
});

// ── 自動組卷 ───────────────────────────────────────────────────
const assemble = require('../server/lib/assemble');

function bankItem(id, module, type, count, difficulty = 'band 6-7', start = 1) {
  const questions = Array.from({ length: count }, (_, i) => ({
    number: start + i, text: `Q${start + i}`, answers: type === 'tfng' ? ['TRUE'] : ['word'],
  }));
  return {
    id, module, type, difficulty,
    payload: {
      group: { type, instructions: 'x', wordLimit: type === 'gap_fill' ? 2 : null, questions },
      passage: module === 'reading' ? '<p>text</p>' : null,
      transcript: module === 'listening' ? 'script' : null,
    },
  };
}

test('自動組卷會湊到目標題數', () => {
  const bank = [];
  for (let i = 0; i < 8; i += 1) bank.push(bankItem(i + 1, 'reading', i % 2 ? 'tfng' : 'short_answer', 5));
  const out = assemble.assemble(bank, { targets: { reading: 20 } });
  assert.equal(out.ok, true, (out.errors || []).join('; '));
  assert.equal(out.stats.reading, 20, `應該剛好 20 題，實際 ${out.stats.reading}`);
});

test('自動組卷的題號連續且不重複', () => {
  const bank = [];
  // 每一組題號都從 1 開始，組卷時一定要重編
  for (let i = 0; i < 6; i += 1) bank.push(bankItem(i + 1, 'reading', 'tfng', 4));
  const out = assemble.assemble(bank, { targets: { reading: 24 } });
  assert.equal(out.ok, true, (out.errors || []).join('; '));
  const { flattenQuestions, normalizePaper: np } = require('../server/lib/paper');
  const nums = flattenQuestions(np(out.paper), 'reading').map((q) => q.number);
  assert.deepEqual(nums, Array.from({ length: 24 }, (_, i) => i + 1), '題號應該是 1..24');
});

test('自動組卷會分散題型，不會整份都同一種', () => {
  const bank = [];
  for (let i = 0; i < 4; i += 1) bank.push(bankItem(i + 1, 'reading', 'tfng', 5));
  for (let i = 0; i < 4; i += 1) bank.push(bankItem(i + 10, 'reading', 'short_answer', 5));
  const out = assemble.assemble(bank, { targets: { reading: 20 }, seed: 7 });
  const kinds = new Set(out.report.picked.reading.typeMix.map((t) => t.type));
  assert.ok(kinds.size >= 2, `應該混到至少兩種題型，實際 ${[...kinds].join(',')}`);
});

test('題庫不夠時老實回報還差幾題，不會硬湊', () => {
  const bank = [bankItem(1, 'reading', 'tfng', 5), bankItem(2, 'reading', 'tfng', 5)];
  const out = assemble.assemble(bank, { targets: { reading: 40 } });
  assert.ok(out.report.shortfall.reading, '應該回報缺口');
  assert.equal(out.report.shortfall.reading.got, 10);
  assert.equal(out.report.shortfall.reading.missing, 30);
  // 不能重複使用同一個題組來湊數
  const { flattenQuestions, normalizePaper: np } = require('../server/lib/paper');
  const nums = flattenQuestions(np(out.paper), 'reading').map((q) => q.number);
  assert.equal(new Set(nums).size, nums.length, '不能有重複題號');
});

test('指定難度湊不夠時會自動放寬並說明', () => {
  const bank = [
    bankItem(1, 'reading', 'tfng', 5, 'band 8-9'),
    bankItem(2, 'reading', 'tfng', 5, 'band 5-6'),
    bankItem(3, 'reading', 'tfng', 5, 'band 5-6'),
  ];
  const out = assemble.assemble(bank, { targets: { reading: 15 }, difficulty: 'band 8-9' });
  assert.ok(out.report.relaxed.includes('reading'), '應該標記已放寬難度');
  assert.equal(out.stats.reading, 15);
});

test('聽力會分成 4 節、閱讀 3 篇', () => {
  const bank = [];
  for (let i = 0; i < 8; i += 1) bank.push(bankItem(i + 1, 'listening', 'gap_fill', 5));
  for (let i = 0; i < 8; i += 1) bank.push(bankItem(i + 20, 'reading', 'tfng', 5));
  const out = assemble.assemble(bank, { targets: { listening: 40, reading: 40 } });
  const l = out.paper.modules.find((m) => m.module === 'listening');
  const r = out.paper.modules.find((m) => m.module === 'reading');
  assert.equal(l.sections.length, 4, '聽力 4 節');
  assert.equal(r.sections.length, 3, '閱讀 3 篇');
});

test('coverage 算得出題庫夠不夠', () => {
  const bank = [
    bankItem(1, 'reading', 'tfng', 5),
    bankItem(2, 'reading', 'short_answer', 3),
    bankItem(3, 'listening', 'gap_fill', 10, 'band 5-6'),
  ];
  const c = assemble.coverage(bank);
  assert.equal(c.reading.questions, 8);
  assert.equal(c.reading.groups, 2);
  assert.equal(c.listening.questions, 10);
  assert.equal(c.reading.byType.tfng, 5);
  assert.equal(c.listening.byDifficulty['band 5-6'], 10);
});

test('同一個 seed 組出來的結果一樣', () => {
  const bank = [];
  for (let i = 0; i < 10; i += 1) bank.push(bankItem(i + 1, 'reading', i % 3 ? 'tfng' : 'short_answer', 4));
  const a = assemble.assemble(bank, { targets: { reading: 20 }, seed: 42 });
  const b = assemble.assemble(bank, { targets: { reading: 20 }, seed: 42 });
  assert.deepEqual(a.report.usedIds, b.report.usedIds, '同 seed 應該挑到同一批題組');
});

// ── SMTP 客戶端 ───────────────────────────────────────────
// 這一組是拿假的 SMTP 伺服器實測指令往返，不是只檢查字串組法。
// 會這樣測是因為手寫的 SMTP 曾經漏掉「STARTTLS／AUTH 之前要先 EHLO」，
// 對方伺服器會回 503，而單看程式碼很難發現。
const notify = require('../server/lib/notify');
const { startFakeSmtp } = require('./helpers/fakeSmtp');

const MAIL = {
  from: 'noreply@school.edu', fromName: 'IELTS 模擬考',
  to: ['stu@example.com'], subject: '明天要考雅思囉', text: '同學你好：\n這是一封測試信。',
};

test('SMTP：EHLO 一定在最前面，指令順序正確', async () => {
  const s = await startFakeSmtp();
  try {
    await notify.smtpSend({ host: '127.0.0.1', port: s.port, secure: false, ...MAIL });
    assert.deepEqual(s.cmds(), ['EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
  } finally { await s.close(); }
});

test('SMTP：STARTTLS 之前先送 EHLO（不然對方回 503）', async () => {
  const s = await startFakeSmtp({ offerStartTls: true });
  try {
    // 假伺服器不做真的交握，收到 STARTTLS 就斷線；這裡只驗順序
    await notify.smtpSend({ host: '127.0.0.1', port: s.port, secure: false, ...MAIL }, 3000)
      .then(() => null, () => null);
    assert.deepEqual(s.cmds(), ['EHLO', 'STARTTLS']);
    assert.ok(!s.log.some((x) => x.type === 'cmd' && /503/.test(x.line)));
  } finally { await s.close(); }
});

test('SMTP：伺服器沒有 STARTTLS 時不會硬送', async () => {
  const s = await startFakeSmtp({ offerStartTls: false });
  try {
    await notify.smtpSend({ host: '127.0.0.1', port: s.port, secure: false, ...MAIL });
    assert.ok(!s.cmds().includes('STARTTLS'));
  } finally { await s.close(); }
});

test('SMTP：AUTH LOGIN 把帳密照著 base64 送出去', async () => {
  const s = await startFakeSmtp();
  try {
    await notify.smtpSend({
      host: '127.0.0.1', port: s.port, secure: false, user: 'me@school.edu', pass: 'app-pw', ...MAIL,
    });
    assert.equal(s.log.find((x) => x.type === 'user')?.value, 'me@school.edu');
    assert.equal(s.log.find((x) => x.type === 'pass')?.value, 'app-pw');
    assert.ok(s.cmds().includes('AUTH'));
  } finally { await s.close(); }
});

test('SMTP：沒有帳號就不送 AUTH（內網轉信主機）', async () => {
  const s = await startFakeSmtp();
  try {
    await notify.smtpSend({ host: '127.0.0.1', port: s.port, secure: false, user: '', ...MAIL });
    assert.ok(!s.cmds().includes('AUTH'));
  } finally { await s.close(); }
});

test('SMTP：每個收件者各送一次 RCPT', async () => {
  const s = await startFakeSmtp();
  try {
    await notify.smtpSend({
      host: '127.0.0.1', port: s.port, secure: false, ...MAIL, to: ['a@x.com', 'b@y.com'],
    });
    assert.equal(s.cmds().filter((c) => c === 'RCPT').length, 2);
  } finally { await s.close(); }
});

test('SMTP：中文主旨與內文都收得回原文', async () => {
  const s = await startFakeSmtp();
  try {
    await notify.smtpSend({ host: '127.0.0.1', port: s.port, secure: false, ...MAIL });
    const raw = s.log.find((x) => x.type === 'message').raw;
    const subj = raw.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1];
    assert.equal(Buffer.from(subj, 'base64').toString(), '明天要考雅思囉');
    const body = Buffer.from(raw.split('\n\n')[1].replace(/\n/g, ''), 'base64').toString();
    assert.ok(body.includes('這是一封測試信'));
  } finally { await s.close(); }
});

test('SMTP：信裡有 Date 與 Message-ID（少了會被當垃圾信）', () => {
  const raw = notify.buildMessage({ ...MAIL, date: new Date('2026-08-01T00:00:00Z'), id: 'abc' });
  assert.match(raw, /^Date: Sat, 01 Aug 2026 00:00:00 \+0000$/m);
  assert.match(raw, /^Message-ID: <abc@school\.edu>$/m);
  assert.match(raw, /^From: =\?UTF-8\?B\?.+\?= <noreply@school\.edu>$/m);
});

test('SMTP：連不到主機時給得出錯誤，而且不會卡住', async () => {
  const t0 = Date.now();
  const err = await notify.smtpSend(
    { host: '127.0.0.1', port: 1, ...MAIL }, 3000).then(() => null, (e) => e.message);
  assert.ok(err, '應該要 reject');
  assert.ok(Date.now() - t0 < 4000, `花了 ${Date.now() - t0}ms，太久了`);
});

test('SMTP：沒有主機或收件者時直接擋下來', async () => {
  await assert.rejects(() => notify.smtpSend({ ...MAIL, host: '' }), /主機/);
  await assert.rejects(() => notify.smtpSend({ ...MAIL, host: 'x', to: [] }), /收件者/);
});

// ── 紀律事件分級 ──────────────────────────────────────────
// 這一組守的是一個真實踩到的坑：學生在口說時為了開麥克風權限退出全螢幕，
// 被記成作弊。口說本來就沒要求全螢幕，那離開全螢幕就不該算違規。
const conduct = require('../server/lib/conduct');

test('分級：口說離開全螢幕不算違規（那一科本來就沒要求）', () => {
  const r = conduct.classify('fullscreen_exit', { module: 'speaking' });
  assert.equal(r.severity, 'info');
  assert.match(r.reason, /不要求全螢幕/);
  assert.equal(conduct.countsAsLeave(r.severity), false);
});

test('分級：其他科離開全螢幕仍然算違規', () => {
  const r = conduct.classify('fullscreen_exit', { module: 'listening' });
  assert.equal(r.severity, 'warn');
  assert.equal(conduct.countsAsLeave(r.severity), true);
});

test('分級：剛回報裝置問題時，離開畫面視為處理權限', () => {
  const r = conduct.classify('leave', { module: 'speaking', msSinceDeviceIssue: 30_000 });
  assert.equal(r.severity, 'info');
  assert.match(r.reason, /裝置權限/);
});

test('分級：寬限期過了就恢復正常判定', () => {
  const r = conduct.classify('leave', { module: 'speaking', msSinceDeviceIssue: conduct.DEVICE_GRACE_MS + 1 });
  assert.equal(r.severity, 'warn');
});

test('分級：沒有裝置問題時，切分頁一律算違規', () => {
  assert.equal(conduct.classify('leave', { module: 'reading' }).severity, 'warn');
  assert.equal(conduct.classify('leave', { module: 'reading', msSinceDeviceIssue: null }).severity, 'warn');
});

test('分級：複製題目與開發者工具是可疑等級', () => {
  assert.equal(conduct.classify('copy_blocked', { module: 'reading' }).severity, 'alert');
  assert.equal(conduct.classify('devtools', {}).severity, 'alert');
  assert.equal(conduct.countsAsLeave('alert'), true);
});

test('分級：系統自己的紀錄不算違規', () => {
  for (const t of ['return', 'fullscreen_enter', 'resize', 'device_permission']) {
    assert.equal(conduct.classify(t, { module: 'listening' }).severity, 'info', t);
  }
});

test('分級：寬限期不會讓「嘗試複製」變成沒事', () => {
  // 裝置問題只寬限「離開」，不能連作弊行為一起赦免
  const r = conduct.classify('copy_blocked', { module: 'reading', msSinceDeviceIssue: 1000 });
  assert.equal(r.severity, 'alert');
});

// ── 考前環境診斷 ──────────────────────────────────────────
const devicecheck = require('../server/lib/devicecheck');

test('診斷：全部通過時 ok = true', () => {
  const raw = Object.fromEntries(Object.keys(devicecheck.CHECKS).map((k) => [k, { status: 'pass' }]));
  const out = devicecheck.sanitize(raw);
  assert.equal(out.ok, true);
  assert.equal(out.score, 100);
  assert.deepEqual(out.criticalFails, []);
});

test('診斷：必要項目沒過會被單獨列出來', () => {
  const out = devicecheck.sanitize({ mic: { status: 'fail', note: '權限被拒' }, secure: { status: 'pass' } });
  assert.equal(out.ok, false);
  assert.deepEqual(out.criticalFails, ['麥克風']);
  assert.match(out.summary, /麥克風：權限被拒/);
});

test('診斷：警告也會讓 ok 變 false，但不算必要失敗', () => {
  const out = devicecheck.sanitize({ screen: { status: 'warn', note: '視窗太窄' } });
  assert.equal(out.ok, false);
  assert.deepEqual(out.criticalFails, []);
});

test('診斷：略過的項目不列入分數', () => {
  const out = devicecheck.sanitize({ mic: { status: 'pass' }, turnstile: { status: 'skip' } });
  assert.equal(out.score, 100, '被略過的不該把分數拉低');
});

test('診斷：亂七八糟的輸入不會炸，也不會被原封不動存下來', () => {
  const out = devicecheck.sanitize({
    mic: { status: '<script>alert(1)</script>', note: 'x'.repeat(9999) },
    不存在的項目: { status: 'pass' },
    __proto__: { polluted: true },
  });
  assert.equal(out.results.mic.status, 'skip', '不認得的狀態要退成 skip');
  assert.ok(out.results.mic.note.length <= 120, 'note 要截斷');
  assert.ok(!('不存在的項目' in out.results), '只收白名單裡的項目');
  assert.equal({}.polluted, undefined, '不能被原型污染');
});

test('診斷：null / 字串 / 陣列都吃得下去', () => {
  for (const bad of [null, undefined, 'hello', 42, [1, 2, 3]]) {
    const out = devicecheck.sanitize(bad);
    assert.equal(typeof out.score, 'number');
    assert.equal(Object.keys(out.results).length, Object.keys(devicecheck.CHECKS).length);
  }
});

test('診斷碼：長度固定，而且不含容易看錯的字', () => {
  for (let i = 0; i < 200; i += 1) {
    const c = devicecheck.makeCode();
    assert.equal(c.length, 6);
    assert.ok(!/[01IO]/.test(c), `${c} 含有容易看錯的字元`);
  }
});

// ── 出題難度 ──────────────────────────────────────────────
// 重點不是「有沒有把 band 傳下去」，而是「band 有沒有被翻譯成 AI 聽得懂的
// 具體指令」。叫模型出 band 5-6 而不給字數，它照樣寫一篇 1000 字學術文章。
const diffLib = require('../server/lib/difficulty');

test('難度：只給整體難度時四科都跟著走', () => {
  const s = diffLib.resolve({ level: 'band 7-8' });
  for (const m of diffLib.MODULES) {
    assert.equal(s.modules[m].level, 'band 7-8', m);
    assert.equal(s.modules[m].overridden, false, m);
  }
});

test('難度：某一科可以單獨覆寫，其他科不受影響', () => {
  const s = diffLib.resolve({ level: 'band 7-8', perModule: { listening: 'band 4-5' } });
  assert.equal(s.modules.listening.level, 'band 4-5');
  assert.equal(s.modules.listening.overridden, true);
  assert.equal(s.modules.reading.level, 'band 7-8');
  assert.equal(s.modules.reading.overridden, false);
});

test('難度：微調預設 auto，會取用該 band 的預設檔位', () => {
  const easy = diffLib.resolve({ level: 'band 4-5' });
  const hard = diffLib.resolve({ level: 'band 8-9' });
  assert.equal(easy.modules.reading.knobs.hardTypes, 'few');
  assert.equal(hard.modules.reading.knobs.hardTypes, 'many');
  assert.equal(easy.modules.listening.knobs.listening, 'slow');
  assert.equal(hard.modules.listening.knobs.listening, 'fast');
});

test('難度：微調設定會蓋掉 band 的預設，而且套用到每一科', () => {
  const s = diffLib.resolve({ level: 'band 8-9', knobs: { vocab: 'common' } });
  for (const m of diffLib.MODULES) assert.equal(s.modules[m].knobs.vocab, 'common', m);
  assert.equal(s.modules.reading.knobs.text, 'dense', '沒動到的項目要維持 band 預設');
});

test('難度：亂送的值一律退回預設，不會壞掉', () => {
  for (const bad of [null, undefined, 'nonsense', 42, { level: '<script>' }]) {
    const s = diffLib.resolve(typeof bad === 'object' && bad ? bad : { level: bad });
    assert.equal(s.level, diffLib.DEFAULT_LEVEL);
  }
  const s2 = diffLib.resolve({ level: 'band 7-8', knobs: { vocab: 'DROP TABLE' }, perModule: { reading: 'band 99' } });
  assert.equal(s2.knobs.vocab, 'auto');
  assert.equal(s2.modules.reading.level, 'band 7-8', '不認得的科目難度要退回整體');
});

test('難度：提示裡真的有具體字數，不是只寫一句 band', () => {
  const easy = diffLib.promptFor('reading', diffLib.resolve({ level: 'band 4-5' }));
  const hard = diffLib.promptFor('reading', diffLib.resolve({ level: 'band 8-9' }));
  assert.match(easy, /Passage length: 500-650 words/);
  assert.match(hard, /Passage length: 1050-1200 words/);
  assert.ok(hard.length > 200, '難度指令不能只有一行');
});

test('難度：General Training 的閱讀字數比 Academic 短', () => {
  const spec = diffLib.resolve({ level: 'band 6-7' });
  const ac = diffLib.promptFor('reading', spec, { testType: 'academic' });
  const gt = diffLib.promptFor('reading', spec, { testType: 'general' });
  const num = (t) => Number(t.match(/Passage length: (\d+)/)[1]);
  assert.ok(num(gt) < num(ac), `GT ${num(gt)} 應該比 Academic ${num(ac)} 短`);
});

test('難度：聽力提示會講語速，閱讀不會', () => {
  const s = diffLib.resolve({ level: 'band 8-9' });
  assert.match(diffLib.promptFor('listening', s), /160 words per minute/);
  assert.ok(!/words per minute/.test(diffLib.promptFor('reading', s)));
});

test('難度：低難度不會叫 AI 塞一堆 NOT GIVEN', () => {
  const easy = diffLib.promptFor('reading', diffLib.resolve({ level: 'band 4-5' }));
  const hard = diffLib.promptFor('reading', diffLib.resolve({ level: 'band 8-9' }));
  assert.match(easy, /LOW-inference/);
  assert.match(hard, /HIGH-inference/);
  assert.match(hard, /Not Given items must be genuinely not stated/);
});

test('難度：寫作與口說也吃得到難度，不是只有聽讀', () => {
  const easy = diffLib.resolve({ level: 'band 4-5' });
  const hard = diffLib.resolve({ level: 'band 8-9' });
  assert.match(diffLib.promptFor('writing', easy), /concrete, familiar question/);
  assert.match(diffLib.promptFor('writing', hard), /abstract, two-part or evaluative/);
  assert.match(diffLib.promptFor('speaking', hard), /genuinely abstract and evaluative/);
});

test('難度：中文說明看得出實際差別', () => {
  const d = diffLib.describe(diffLib.resolve({ level: 'band 4-5' }));
  assert.match(d.reading, /Band 4–5/);
  assert.match(d.reading, /500–650 字/);
  assert.match(d.listening, /wpm/);
  assert.ok(!/字範圍/.test(d.writing), '寫作那行不能出現會被讀成作文字數的字樣');
});

test('難度：認不得的科目不會炸', () => {
  assert.equal(diffLib.promptFor('nonsense', diffLib.resolve({})), '');
});

// ── 檢討素材 ──────────────────────────────────────────────
// 這一組守的是：考完檢討時看得到當初的文章與圖片。
// 之前 flattenQuestions 只留題幹，學生打開錯題只看到一句話，
// 根本回想不起來當初在讀什麼。
const { sectionMedia: secMedia, flattenQuestions: flatQ } = require('../server/lib/paper');

const MEDIA_PAPER = {
  title: 'x', testType: 'academic',
  modules: [{
    module: 'reading',
    sections: [
      { title: 'Passage 1', passageTitle: 'Trees', passage: '<p>Text one.</p>',
        groups: [{ type: 'tfng', instructions: 'Do the statements agree?',
          questions: [{ number: 1, text: 'A', answers: ['TRUE'] }] }] },
      { title: 'Passage 2', passage: '<p>Text two.</p>',
        groups: [{ type: 'label_image', image: '/uploads/image/g.png',
          bodyHtml: '<p>Fill [[2]]</p>',
          questions: [{ number: 2, text: 'B', answers: ['x'], image: '/uploads/image/q.png' }] }] },
    ],
  }],
};

test('檢討素材：sectionMedia 一節一份，拿得到文章與標題', () => {
  const m = secMedia(MEDIA_PAPER, 'reading');
  assert.equal(m.length, 2);
  assert.equal(m[0].passageTitle, 'Trees');
  assert.match(m[0].passage, /Text one/);
  assert.match(m[1].passage, /Text two/);
  assert.equal(m[0].index, 0);
});

test('檢討素材：認不得的科目回空陣列，不會炸', () => {
  assert.deepEqual(secMedia(MEDIA_PAPER, 'listening'), []);
  assert.deepEqual(secMedia({}, 'reading'), []);
});

test('檢討素材：題目本身帶得走圖片、作答說明與填空版面', () => {
  const qs = flatQ(MEDIA_PAPER, 'reading');
  assert.equal(qs[0].instructions, 'Do the statements agree?');
  assert.equal(qs[1].image, '/uploads/image/q.png', '題目自己的圖優先');
  assert.match(qs[1].bodyHtml, /\[\[2\]\]/);
  assert.equal(qs[0].image, null, '沒有圖的題目要是 null 而不是 undefined');
});

test('檢討素材：題目上不會夾帶整篇文章（一篇千字複製十三份太浪費）', () => {
  for (const q of flatQ(MEDIA_PAPER, 'reading')) {
    assert.ok(!('passage' in q), `第 ${q.number} 題不該帶 passage`);
    assert.ok(!('transcript' in q), `第 ${q.number} 題不該帶 transcript`);
  }
});

test('檢討素材：題目找得到自己屬於哪一節，才對得回文章', () => {
  const qs = flatQ(MEDIA_PAPER, 'reading');
  const media = secMedia(MEDIA_PAPER, 'reading');
  assert.equal(qs[0].sectionIndex, 0);
  assert.equal(qs[1].sectionIndex, 1);
  assert.match(media[qs[1].sectionIndex].passage, /Text two/, '對得回正確那一篇');
});

test('檢討素材：沒有圖沒有文章的聽力題也不會出錯', () => {
  const p = {
    title: 'x', testType: 'academic',
    modules: [{ module: 'listening', sections: [{ title: 'S1', transcript: 'Hello.',
      groups: [{ type: 'gap_fill', questions: [{ number: 1, text: '', answers: ['a'] }] }] }] }],
  };
  const m = secMedia(p, 'listening');
  assert.equal(m[0].transcript, 'Hello.');
  assert.equal(m[0].passage, null);
  assert.equal(flatQ(p, 'listening')[0].image, null);
});

test('檢討素材：配合題的共用選項會被標成 shared，單選題不會', () => {
  const p = {
    title: 'x', testType: 'academic',
    modules: [{ module: 'reading', sections: [{ title: 'S1', passage: '<p>t</p>', groups: [
      { type: 'matching', instructions: 'Choose the heading.',
        options: [{ key: 'i', text: 'One' }, { key: 'ii', text: 'Two' }],
        questions: [{ number: 1, text: 'Para A', answers: ['i'] },
                    { number: 2, text: 'Para B', answers: ['ii'] }] },
      { type: 'mcq_single',
        questions: [{ number: 3, text: 'Q', options: [{ key: 'A', text: 'a' }], answers: ['A'] }] },
    ] }] }],
  };
  const qs = flatQ(p, 'reading');
  assert.equal(qs[0].optionsShared, true, '配合題的選項是整組共用的');
  assert.equal(qs[1].optionsShared, true);
  assert.equal(qs[0].groupIndex, qs[1].groupIndex, '同一組才畫得成一份');
  assert.equal(qs[2].optionsShared, false, '單選題的選項是每題自己的');
  assert.equal(qs[2].groupIndex, 1);
});

test('檢討素材：配合題的選項真的帶到每一題上（不是只有第一題）', () => {
  const p = {
    title: 'x', testType: 'academic',
    modules: [{ module: 'reading', sections: [{ title: 'S1', groups: [
      { type: 'matching', options: [{ key: 'i', text: 'One' }, { key: 'ii', text: 'Two' }],
        questions: [{ number: 1, text: 'A', answers: ['i'] }, { number: 2, text: 'B', answers: ['ii'] }] },
    ] }] }],
  };
  for (const q of flatQ(p, 'reading')) {
    assert.equal((q.options || []).length, 2, `第 ${q.number} 題應該拿得到選項`);
  }
});

// ── Realtime 協定版本 ─────────────────────────────────────
// OpenAI 把 Realtime 從 Beta 轉成 GA：不能再送 OpenAI-Beta 標頭，
// session.update 也換了結構。兩種都要能組得出來。
const realtime = require('../server/lib/realtime');

test('Realtime：GA 與 Beta 的 session.update 結構不同', () => {
  // 直接用模組匯出的組裝函式驗，不需要真的連線
  const script = realtime.buildScript({ modules: [{ module: 'speaking', sections: [{ groups: [{
    type: 'speaking_part',
    questions: [{ part: 1, topic: 'Home', items: ['Where do you live?'] }],
  }] }] }] });
  assert.equal(script.part1.length, 1, 'buildScript 抓得到 Part 1');

  const inst = realtime.examinerInstructions(script, 'part1');
  assert.match(inst, /Where do you live\?/, '題目有進到考官指示裡');
  assert.match(inst, /Part 1/, '階段名稱也在');
});

test('Realtime：GA 事件名稱對得回舊名', () => {
  const a = realtime.GA_EVENT_ALIASES;
  assert.equal(a['response.output_audio.delta'], 'response.audio.delta');
  assert.equal(a['response.output_audio_transcript.delta'], 'response.audio_transcript.delta');
  assert.equal(a['response.output_audio_transcript.done'], 'response.audio_transcript.done');
  assert.equal(a['conversation.item.audio_transcription.completed'],
    'conversation.item.input_audio_transcription.completed');
});

test('Realtime：sessionPayload 兩種協定各自正確', () => {
  const S = realtime.buildSessionPayload;
  const script = { part1: [], part2: null, part3: [], rounding: [] };
  const cfg = { voice: 'marin', sttModel: 'whisper-1' };

  const beta = S({ script, phase: 'part1', cfg, flavor: 'beta' });
  assert.deepEqual(beta.session.modalities, ['text', 'audio'], 'Beta 用 modalities');
  assert.equal(beta.session.input_audio_format, 'pcm16', 'Beta 的 format 是字串');
  assert.equal(beta.session.voice, 'marin');
  assert.equal(beta.session.turn_detection.type, 'server_vad');
  assert.ok(!beta.session.audio, 'Beta 沒有 audio 巢狀');

  const ga = S({ script, phase: 'part1', cfg, flavor: 'ga' });
  assert.equal(ga.session.type, 'realtime', 'GA 一定要有 session.type');
  assert.deepEqual(ga.session.output_modalities, ['audio'], 'GA 用 output_modalities');
  assert.deepEqual(ga.session.audio.input.format, { type: 'audio/pcm', rate: 24000 },
    'GA 的 format 是物件不是字串');
  assert.equal(ga.session.audio.output.voice, 'marin', 'voice 移到 audio.output 底下');
  assert.equal(ga.session.audio.input.transcription.model, 'whisper-1');
  assert.equal(ga.session.audio.input.turn_detection.type, 'server_vad');
  assert.ok(!ga.session.modalities && !ga.session.input_audio_format,
    'GA 不能夾帶舊欄位，夾了會被端點拒絕');
});

// ── 通知的容量控制 ────────────────────────────────────────
// 通知只會長不會短：未讀的照設計一律保留，而每晚的自動清理預設是關的。
// 一個不再登入的學生會永遠累積下去，所以寫入時就要順手修剪。
const notifyLib = require('../server/lib/notify');

test('通知：每人上限與硬保留天數是明確的常數，不是散在 SQL 裡', () => {
  assert.equal(typeof notifyLib.KEEP_PER_USER, 'number');
  assert.equal(typeof notifyLib.HARD_KEEP_DAYS, 'number');
  assert.ok(notifyLib.KEEP_PER_USER >= 50, '上限不能小到把有用的通知也刪掉');
  assert.ok(notifyLib.HARD_KEEP_DAYS >= 90, '已讀的至少留一個學期');
  assert.equal(typeof notifyLib.trim, 'function');
});

test('通知：修剪不使用視窗函式（MySQL 5.7 沒有）', () => {
  const src = require('fs').readFileSync(require.resolve('../server/lib/notify'), 'utf8');
  const trimSrc = src.slice(src.indexOf('async function trim('), src.indexOf('async function listFor('));
  assert.ok(!/ROW_NUMBER|OVER\s*\(/i.test(trimSrc),
    'README 寫的最低需求是 MySQL 5.7，那個版本沒有視窗函式');
  assert.match(trimSrc, /LIMIT 500/, '一次刪除要有上限，不能拖慢送通知');
});

// ── 每一種題型，學生真的按得下去嗎 ────────────────────────
// 這一組全部來自實測：把試卷送到瀏覽器裡看學生螢幕上有沒有可以點的東西。
// 底下每一種寫法，以前都會通過驗證，然後在考場上變成一題完全不能作答的題目。
const readingWith = (groups) => ({
  title: 'x', testType: 'academic',
  modules: [{ module: 'reading', sections: [{ title: 'P1', passage: 'text', groups }] }],
});

test('驗證：單選題沒有選項要擋下來（學生端會一個圓鈕都沒有）', () => {
  const r = validatePaper(readingWith([
    { type: 'mcq_single', questions: [{ number: 1, text: 'Which?', answers: ['A'] }] },
  ]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /需要 options/);
});

test('驗證：多選題沒有選項要擋下來', () => {
  const r = validatePaper(readingWith([
    { type: 'mcq_multi', selectCount: 2, questions: [{ number: 1, text: 'Which TWO?', answers: ['A', 'B'] }] },
  ]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /需要 options/);
});

test('驗證：題目既沒有題幹也沒有空格，學生看不到題目', () => {
  const r = validatePaper(readingWith([
    { type: 'short_answer', questions: [{ number: 1, answers: ['tree'] }] },
  ]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /學生看不到題目/);
});

test('驗證：多選題整組共用第一題的題幹，第二個題號不必再寫一次', () => {
  const r = validatePaper(readingWith([
    {
      type: 'mcq_multi', selectCount: 2,
      options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }],
      questions: [{ number: 1, text: 'Which TWO?', answers: ['A', 'C'] }, { number: 2, answers: ['A', 'C'] }],
    },
  ]));
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('驗證：填空題用 bodyHtml 的空格當題目就夠了', () => {
  const r = validatePaper(readingWith([
    { type: 'gap_fill', bodyHtml: 'Opens at [[1]].', questions: [{ number: 1, answers: ['nine'] }] },
  ]));
  assert.equal(r.ok, true, r.errors.join('; '));
});

// 這一題最陰險：老師只要打開題目編輯器再存檔，
// 每一題就會被塞一個空的 options 陣列。`q.options || g.options` 把 []
// 當成有值，題組層的選項整組被蓋掉，之後每個考生都看到沒有選項的單選題。
test('正規化：題目層的空選項陣列要拿掉，不能蓋掉題組層的選項', () => {
  const p = normalizePaper(readingWith([
    {
      type: 'mcq_single', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }],
      questions: [{ number: 1, text: 'Q?', answers: ['A'], options: [] }],
    },
  ]));
  const q = p.modules[0].sections[0].groups[0].questions[0];
  assert.equal(q.options, undefined, '空陣列要消失，讓它退回題組層的選項');
  assert.equal(validatePaper(p).ok, true);
});

test('正規化：早期的 prompt 欄位要併成 text，否則學生端題幹一片空白', () => {
  const p = normalizePaper(readingWith([
    { type: 'tfng', questions: [{ number: 1, prompt: 'Statement one.', answers: ['TRUE'] }] },
  ]));
  const q = p.modules[0].sections[0].groups[0].questions[0];
  assert.equal(q.text, 'Statement one.');
  assert.equal(validatePaper(p).ok, true, '用 prompt 寫的舊題庫不能因此壞掉');
});

test('答案不會外流：答案、解析、範文都不能送到學生端', () => {
  const safe = stripAnswers(normalizePaper({
    title: 'x', testType: 'academic',
    modules: [{
      module: 'listening',
      sections: [{
        title: 'S1', transcript: 'WOMAN: the answer is nine.',
        groups: [{
          type: 'gap_fill', bodyHtml: 'Opens at [[1]].',
          questions: [{ number: 1, answers: ['nine'], explanation: '第三句', sampleAnswer: 'nine' }],
        }],
      }],
    }],
  }));
  const j = JSON.stringify(safe);
  assert.ok(!/"answers"/.test(j), '答案欄位整個不能留');
  assert.ok(!j.includes('第三句'), '解析不能給學生');
  assert.ok(!/"sampleAnswer"/.test(j), '範文不能給學生');
  // 逐字稿不歸 stripAnswers 管，是 GET /exam/:id 另外拿掉的，
  // 所以這裡只確認它還在，別讓人以為 stripAnswers 已經處理過了。
  assert.ok(safe.modules[0].sections[0].transcript, '逐字稿由考卷路由負責移除');
});

// ── 離開次數怎麼算 ────────────────────────────────────────
// 這一組來自實測：反作弊的「次數」在三個地方各算各的，而且算法不一樣。

test('離開次數：規則只有一份，不能各處抄一份 SQL', () => {
  const fs = require('fs');
  assert.match(conduct.LEAVE_WHERE, /severity <> 'info'/);
  for (const f of ['../server/routes/exam.js', '../server/routes/results.js']) {
    const src = fs.readFileSync(require.resolve(f), 'utf8');
    const handRolled = src.match(/type IN \('leave','fullscreen_exit'\)/g) || [];
    assert.equal(handRolled.length, 0,
      `${f} 又自己抄了一份離開次數的條件，請改用 conduct.LEAVE_WHERE / LEAVE_TYPES`);
  }
});

// 介面上寫的是「**允許**離開畫面幾次」+「**超過**上限時」。
// 舊版用 count >= maxLeaves，在第二次就收卷，比老師設定的嚴格一級。
test('上限：設 2 次代表離開兩次沒事，第三次才處置', () => {
  assert.equal(conduct.exceedsLimit(1, 2), false);
  assert.equal(conduct.exceedsLimit(2, 2), false, '第 2 次還在允許範圍內');
  assert.equal(conduct.exceedsLimit(3, 2), true);
});

test('上限：設 0 代表不限，永遠不處置', () => {
  assert.equal(conduct.exceedsLimit(99, 0), false);
  assert.equal(conduct.remainingLeaves(99, 0), Infinity);
});

test('上限：「再離開幾次就會自動收卷」算得對', () => {
  assert.equal(conduct.remainingLeaves(0, 2), 3);
  assert.equal(conduct.remainingLeaves(1, 2), 2);
  assert.equal(conduct.remainingLeaves(2, 2), 1);
  assert.equal(conduct.remainingLeaves(3, 2), 0);
});

// 切一次分頁，瀏覽器會先送 blur、再送 visibilitychange。
// 舊版兩個監聽器各記一次，學生切走一次被記成兩次；
// 老師設「允許 2 次、超過收卷」的話，第一次切分頁就直接被收卷。
test('離開次數：前端把離開當成狀態，不是一連串事件', () => {
  const src = require('fs').readFileSync(require.resolve('../public/js/exam.js'), 'utf8');
  const block = src.slice(src.indexOf('function setupProctoring'), src.indexOf("document.addEventListener('copy'"));
  assert.match(block, /let away = false/, '要有「人在不在」的狀態');
  assert.match(block, /function markAway/);
  assert.match(block, /if \(away\s*\|\|/, '已經在外面就不能再記一次');
  assert.match(block, /function markBack/, '回來要能把狀態清掉，下一次離開才算得到');
  // 記一筆離開的地方只能有一個（markAway 裡面），blur 與 visibilitychange
  // 都要走它。兩個監聽器各自記一筆的話，切一次分頁就會變成兩次。
  assert.equal((block.match(/onViolation\('leave'/g) || []).length, 1,
    'blur 與 visibilitychange 都要走 markAway，不能各自直接記一筆');
  assert.equal((block.match(/markAway\(/g) || []).length, 3,
    'markAway 應該是一次定義 + 兩個監聽器各呼叫一次');
});

test('紀錄型事件不能被算成「需留意」', () => {
  const src = require('fs').readFileSync(require.resolve('../server/routes/exam.js'), 'utf8');
  const inserts = src.match(/INSERT INTO exam_events[^;]*/g) || [];
  assert.ok(inserts.length > 0);
  for (const i of inserts) {
    assert.match(i, /severity/,
      'severity 欄位的預設值是 warn，不明寫的話純紀錄也會被算成違規');
  }
});

// ── 口說即時對話：換手與打斷 ──────────────────────────────
// 這一組守的是實測出來的一組問題：整場只設定一次語音偵測，
// Part 2 的兩分鐘長回答因此每停頓 0.7 秒就被考官插話一次。
const rt = require('../server/lib/realtime');

const SCRIPT = {
  part1: [{ topic: 'Hometown', items: ['Where do you live?'] }],
  part2: { topic: 'A park', bullets: ['where', 'what', 'why'], prepSec: 60, talkSec: 120 },
  part3: [{ topic: 'Cities', items: ['More parks?'] }],
  rounding: ['Do you go often?'],
};
const vadOf = (phase) => {
  const p = rt.buildSessionPayload({ script: SCRIPT, phase, cfg: {}, flavor: 'ga' });
  return p.session.audio.input.turn_detection;
};

test('換手：Part 2 長回答時考官不准自動接話（官方規則不能打斷考生）', () => {
  assert.equal(vadOf('part2_talk').create_response, false);
});

test('換手：Part 2 準備的那一分鐘考官也不准出聲', () => {
  assert.equal(vadOf('part2_prep').create_response, false);
});

test('換手：一問一答的階段照常自動接話', () => {
  for (const p of ['intro', 'part1', 'part2_round', 'part3']) {
    assert.equal(vadOf(p).create_response, true, p);
  }
});

test('換手：停頓門檻要夠寬，換個氣不該被搶話', () => {
  assert.ok(vadOf('part1').silence_duration_ms >= 1000,
    '700 毫秒對考生太短，講到一半換氣就被打斷');
  assert.ok(vadOf('part2_talk').silence_duration_ms >= vadOf('part1').silence_duration_ms,
    '長回答的容忍度不能比一問一答還短');
});

test('每一個階段都有自己的指示，不會掉回 Part 1', () => {
  const seen = new Set();
  for (const p of ['intro', 'part1', 'part2_instruct', 'part2_prep', 'part2_talk',
    'part2_round', 'part3', 'end']) {
    const text = rt.examinerInstructions(SCRIPT, p);
    const stage = text.match(/CURRENT STAGE — ([^\n.]+)/)?.[1];
    assert.ok(stage, p);
    assert.ok(!seen.has(stage), `階段 ${p} 拿到的是「${stage}」的指示，代表它沒有自己的那一段`);
    seen.add(stage);
  }
});

test('Part 2 準備階段的指示要明確叫考官閉嘴', () => {
  const text = rt.examinerInstructions(SCRIPT, 'part2_prep');
  assert.match(text, /Say NOTHING AT ALL/);
});

test('打斷：只有一問一答的階段可以插話', () => {
  assert.equal(rt.BARGE_IN_PHASES.has('part1'), true);
  assert.equal(rt.BARGE_IN_PHASES.has('part3'), true);
  assert.equal(rt.BARGE_IN_PHASES.has('part2_talk'), false, '長回答時考官本來就不該在講話');
  assert.equal(rt.BARGE_IN_PHASES.has('part2_instruct'), false, '讀題讀到一半不該被咳嗽打斷');
});

test('協定層的雜訊不能變成學生畫面上的紅字', () => {
  for (const m of [
    'Cancellation failed: no active response found',
    'Conversation already has an active response',
  ]) assert.match(m, rt.INTERNAL_ERRORS, m);
  assert.ok(!rt.INTERNAL_ERRORS.test('Incorrect API key provided'),
    '真正要讓人知道的錯誤不能被濾掉');
});

/** 只看真正會執行的程式碼 —— 註解裡提到某個字串不代表程式碼在做那件事 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('前端：只有伺服器說算打斷才停掉考官的聲音', () => {
  const src = stripComments(
    require('fs').readFileSync(require.resolve('../public/js/speaking.js'), 'utf8'));
  assert.match(src, /msg\.on && msg\.bargeIn/,
    '無條件停播的話，沒戴耳機時考官會被自己的回音打斷');
  assert.ok(!/cancel_response/.test(src),
    '前端不該自己送 cancel_response —— 只有伺服器知道考官在不在講話');
});

test('前端：上游掉線要有人接，而且要會自動重連', () => {
  const src = require('fs').readFileSync(require.resolve('../public/js/speaking.js'), 'utf8');
  assert.match(src, /case 'upstream_closed'/, '伺服器有送，前端沒接的話學生完全看不到');
  assert.match(src, /case 'upstream_reopened'/);
  assert.match(src, /case 'resumed'/, '接回進度時要把講過的補回畫面');
  assert.match(src, /ws\.onclose[\s\S]{0,400}setTimeout\(\(\) => \{ if \(!S\.finished/,
    '學生那條連線斷掉要自動重連，不能只把字改成「連線中斷」就結束');
});

test('前端：取樣率不是 24k 時要自己降頻', () => {
  const src = require('fs').readFileSync(require.resolve('../public/js/speaking.js'), 'utf8');
  assert.match(src, /function resampleTo24k/,
    'AudioContext 不保證給得到 24kHz，直接當成 24kHz 送上去考官會聽到慢一半的聲音');
  assert.match(src, /S\.inRate = ctx\.sampleRate/, '要用實際拿到的取樣率，不是自己指定的那個');
  assert.match(src, /resampleTo24k\(e\.data, S\.inRate\)/);
});

test('前端：音訊要攢一段再送，不能每 5 毫秒一個封包', () => {
  const src = require('fs').readFileSync(require.resolve('../public/js/speaking.js'), 'utf8');
  const m = src.match(/const CHUNK = Math\.round\(RATE \* ([\d.]+)\)/);
  assert.ok(m, '要有明確的分塊大小');
  assert.ok(Number(m[1]) >= 0.04,
    `每 ${Number(m[1]) * 1000} 毫秒送一次太碎，經過 CDN 之後延遲與抖動都很明顯`);
});

// 這一條守的是整套口說裡最貴的一個教訓：
// `node.connect(ctx.createGain())` —— 接到一個沒有接到喇叭的 GainNode。
// Web Audio 是從喇叭端反向拉資料的，接到懸空的節點整條線根本不會被拉，
// AudioWorkletProcessor.process() 一次都不會被呼叫。
// 實測：懸空 1.5 秒收到 0 個音框，接到 destination 收到 285 個。
// 也就是說學生的聲音從來沒有送出去過，考官全程在自言自語 ——
// 而畫面上一切看起來都正常。
test('前端：麥克風的擷取節點一定要接到 destination，否則整條線不會被拉', () => {
  const src = stripComments(
    require('fs').readFileSync(require.resolve('../public/js/speaking.js'), 'utf8'));
  const block = src.slice(src.indexOf('async function startRealtime'), src.indexOf('function playChunk'));
  assert.ok(!/node\.connect\(ctx\.createGain\(\)\)/.test(block),
    '接到懸空的 GainNode 等於完全沒有錄音');
  assert.match(block, /node\.connect\(mute\)/);
  assert.match(block, /mute\.connect\(ctx\.destination\)/,
    '要靜音就把增益設成 0，不能不接到 destination');
  assert.match(block, /mute\.gain\.value = 0/, '增益不設 0 的話會從喇叭放出來，變成回授');
});
