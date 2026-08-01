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
