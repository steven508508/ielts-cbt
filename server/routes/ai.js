'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireStaff, requireRole } = require('../middleware/auth');
const ai = require('../lib/ai');
const aiTasks = require('../lib/aiTasks');
const jobs = require('../lib/jobs');
const assemble = require('../lib/assemble');
const difficultyLib = require('../lib/difficulty');
const { rateLimit } = require('../middleware/rateLimit');
const bands = require('../lib/bands');
const examiner = require('../lib/examiner');
const { validatePaper, normalizePaper } = require('../lib/paper');

const router = express.Router();
router.use(requireAuth);

/* AI 端點每一次呼叫都在燒錢，一定要有速率限制。
   注意 /grade-writing 是「學生的寫作練習」在用的，不能加 requireStaff，
   否則練習功能會整個壞掉 —— 這裡改用「依使用者」計數。 */
const aiLimit = rateLimit({
  key: 'ai', by: 'user', windowMs: 60_000, max: 8,
  message: 'AI 請求太頻繁',
});
const aiHeavyLimit = rateLimit({
  key: 'ai-heavy', by: 'user', windowMs: 60 * 60_000, max: 12,
  message: '這類請求很耗資源，每小時最多 12 次',
});

// ── 設定 ───────────────────────────────────────────────────────
router.get('/settings', requireStaff, async (req, res) => {
  const cfg = await ai.getConfig(true);
  const misc = await db.getSettings();
  res.json({
    ai: ai.maskConfig(cfg),
    marking: {
      allowSpellingVariants: misc.allowSpellingVariants !== false,
      hyphenEqualsSpace: misc.hyphenEqualsSpace !== false,
      expandContractions: misc.expandContractions !== false,
      bandTables: misc.bandTables || bands.DEFAULT_TABLES,
    },
    examiner: examiner.normalize(misc.speakingExaminer || {}),
    examinerOptions: examiner.options(),
  });
});

router.put('/settings', requireRole('admin'), async (req, res) => {
  const patch = { ...(req.body?.ai || {}) };
  delete patch._hasAnthropicKey; delete patch._hasOpenaiKey; delete patch._hasCustomKey;
  // 前端送回遮罩過的金鑰時不要覆寫
  for (const k of ['anthropicApiKey', 'openaiApiKey', 'customApiKey']) {
    if (patch[k] === undefined || /••••/.test(String(patch[k]))) delete patch[k];
  }
  const cfg = await ai.saveConfig(patch);

  const marking = req.body?.marking || {};
  for (const k of ['allowSpellingVariants', 'hyphenEqualsSpace', 'expandContractions']) {
    if (marking[k] !== undefined) await db.setSetting(k, !!marking[k]);
  }
  if (marking.bandTables) await db.setSetting('bandTables', marking.bandTables);

  // AI 考官設定。整組正規化再存 —— 數字夾在合理範圍、看不懂的值直接忽略，
  // 不要讓一個打錯的數字把整場口說搞掉（例如停頓門檻填 0）。
  if (req.body?.examiner) {
    await db.setSetting('speakingExaminer', examiner.normalize(req.body.examiner));
  }

  const misc2 = await db.getSettings();
  res.json({
    ok: true, ai: ai.maskConfig(cfg),
    examiner: examiner.normalize(misc2.speakingExaminer || {}),
  });
});

router.post('/test', requireStaff, aiLimit, async (req, res) => {
  try {
    res.json(await ai.testConnection(req.body?.role || 'chat'));
  } catch (e) {
    res.status(502).json({ ok: false, error: ai.friendlyError(e) });
  }
});

router.get('/logs', requireStaff, async (req, res) => {
  const rows = await db.query('SELECT * FROM ai_logs ORDER BY id DESC LIMIT 100');
  res.json({ logs: rows });
});

// ── 出題 ───────────────────────────────────────────────────────
router.post('/generate', requireStaff, aiLimit, async (req, res) => {
  try {
    const out = await aiTasks.generateQuestions(req.body || {}, req.user.id);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(502).json({ error: ai.friendlyError(e) });
  }
});

/**
 * 產生整份試卷。
 * 這件事要好幾分鐘，塞在一個 HTTP 請求裡等一定會被逾時擋下
 * （本系統 180 秒、反向代理、Cloudflare 橘雲的 100 秒硬上限），
 * 所以改成背景工作：這裡立刻回 jobId，前端輪詢 /ai/jobs/:id。
 */
/** 出題頁的難度選項與說明 */
router.get('/difficulty', requireStaff, (req, res) => {
  const testType = req.query.testType === 'general' ? 'general' : 'academic';
  const spec = difficultyLib.resolve({
    level: req.query.level,
    perModule: (() => { try { return JSON.parse(req.query.perModule || '{}'); } catch { return {}; } })(),
    knobs: (() => { try { return JSON.parse(req.query.knobs || '{}'); } catch { return {}; } })(),
  });
  res.json({
    levels: Object.fromEntries(Object.entries(difficultyLib.LEVELS)
      .map(([k, v]) => [k, { label: v.label, zh: v.zh }])),
    knobs: Object.fromEntries(Object.entries(difficultyLib.KNOBS).map(([k, v]) => [k, {
      label: v.label, zh: v.zh,
      options: Object.fromEntries(Object.entries(v.options).map(([ok, ov]) => [ok, { label: ov.label, zh: ov.zh || '' }])),
    }])),
    defaultLevel: difficultyLib.DEFAULT_LEVEL,
    resolved: spec,
    describe: difficultyLib.describe(spec, { testType }),
  });
});

router.post('/generate-paper', requireStaff, aiHeavyLimit, async (req, res) => {
  const testType = req.body?.testType === 'general' ? 'general' : 'academic';
  const theme = String(req.body?.theme || '').slice(0, 200);
  // resolve() 自己會把不認得的值退回預設，所以這裡收到什麼都不會壞
  const difficulty = difficultyLib.resolve(req.body?.difficulty || {});

  // 同一個人已經有一個在跑就不要再開，免得白燒額度
  const mine = await jobs.listFor(req.user.id, { limit: 5, kind: 'generate_paper' });
  const busy = mine.find((j) => j.status === 'queued' || j.status === 'running');
  if (busy) return res.status(409).json({ error: '你已經有一份試卷正在產生中', jobId: busy.id });

  const jobId = await jobs.create({
    kind: 'generate_paper', params: { testType, theme, difficulty }, totalSteps: 9, userId: req.user.id,
  });

  jobs.run(jobId, async (ctx) => {
    const raw = await aiTasks.generateFullPaper({ testType, theme, difficulty, userId: req.user.id, ctx });
    const result = validatePaper(normalizePaper(raw));
    return {
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      stats: result.stats,
      issues: raw.generationIssues || [],
      paper: result.paper,
    };
  });

  res.status(202).json({ jobId, totalSteps: 9 });
});

// ── 背景工作進度 ───────────────────────────────────────────────
router.get('/jobs', requireStaff, async (req, res) => {
  res.json({ jobs: await jobs.listFor(req.user.id, { limit: 20, kind: req.query.kind || null }) });
});

router.get('/jobs/:id', requireStaff, async (req, res) => {
  const job = await jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '找不到這個工作' });
  if (job.createdBy !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: '這不是你建立的工作' });
  // 還在跑的時候不要每次都把半成品整包丟回去，太肥
  if (job.status === 'running' && !req.query.partial) job.partial = undefined;
  res.json({ job });
});

router.post('/jobs/:id/cancel', requireStaff, async (req, res) => {
  const job = await jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '找不到這個工作' });
  if (job.createdBy !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: '這不是你建立的工作' });
  res.json({ job: await jobs.cancel(job.id) });
});

/* ── 題庫 ─────────────────────────────────────────────────────
   AI 出題、匯入、或從既有試卷都可以把題組存進來重複使用。
   payload 形狀：{ group, passage?, transcript?, passageTitle? } */

/** 從 payload 算出題數，列表才看得到「幾題」 */
function countQuestions(payload) {
  const g = payload?.group;
  if (!g) return 0;
  if (Array.isArray(g.questions)) return g.questions.length;
  return 0;
}

/** 一組 section 裡最大的題號（沒有題號的題型回 0） */
function maxNumber(sections) {
  let max = 0;
  for (const s of sections || []) {
    for (const g of s.groups || []) {
      for (const q of g.questions || []) {
        const n = Number(q.number);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
  }
  return max;
}

/** 把 section 裡的題號整批往後推，接在既有題目後面 */
function shiftNumbers(sections, afterNumber) {
  if (!afterNumber) return sections;
  let min = Infinity;
  for (const s of sections || []) {
    for (const g of s.groups || []) {
      for (const q of g.questions || []) {
        const n = Number(q.number);
        if (Number.isFinite(n) && n < min) min = n;
      }
    }
  }
  if (!Number.isFinite(min)) return sections;
  const offset = afterNumber - min + 1;
  if (offset <= 0) return sections;
  /* 題號位移之後，bodyHtml 裡的 [[n]] 也要跟著換。
     漏掉的話 validatePaper 會回「缺少空格 [[41]]、多餘的空格 [[1]]」，
     老師只看到一個看不懂的 400 —— 而且併進「新試卷」時沒事、併進
     「現有試卷」時才炸，看起來像隨機發生。 */
  for (const s of sections || []) {
    for (const g of s.groups || []) {
      if (!g.bodyHtml) continue;
      g.bodyHtml = String(g.bodyHtml).replace(/\[\[\s*(\d+)\s*\]\]/g,
        (_, n) => `[[${Number(n) + offset}]]`);
    }
  }
  for (const s of sections || []) {
    for (const g of s.groups || []) {
      for (const q of g.questions || []) {
        if (Number.isFinite(Number(q.number))) q.number = Number(q.number) + offset;
      }
      if (Number.isFinite(Number(g.startNumber))) g.startNumber = Number(g.startNumber) + offset;
    }
  }
  return sections;
}

/** 把題庫項目還原成可以合併進試卷的 paper 結構 */
function bankItemToPaper(row, title) {
  const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const section = {
    title: p.sectionTitle
      || (row.module === 'reading' ? 'Reading Passage' : row.module === 'listening' ? 'Section' : 'Part'),
    passageTitle: p.passageTitle || null,
    passage: p.passage || null,
    transcript: p.transcript || null,
    groups: p.group ? [p.group] : (p.groups || []),
  };
  return {
    title: title || `題庫 #${row.id} — ${row.topic || row.type}`,
    testType: 'academic',
    modules: [{ module: row.module, sections: [section] }],
  };
}

/** 存進題庫 */
router.post('/bank', requireStaff, async (req, res) => {
  const { module: mod, type, topic, difficulty, tags, payload, source = 'ai' } = req.body || {};
  if (!mod || !type) return res.status(400).json({ error: '缺少 module 或 type' });
  if (!payload || (!payload.group && !payload.groups)) {
    return res.status(400).json({ error: 'payload 至少要有一個題組（group）' });
  }
  const id = await db.insert(
    'INSERT INTO question_bank (module, type, topic, difficulty, tags, payload, source, created_by) VALUES (?,?,?,?,?,?,?,?)',
    [mod, type, topic || null, difficulty || null, tags || null, JSON.stringify(payload), source, req.user.id]
  );
  res.json({ id });
});

router.get('/bank', requireStaff, async (req, res) => {
  const { module: mod, type, source, q } = req.query;
  const where = [];
  const params = [];
  if (mod) { where.push('b.module = ?'); params.push(mod); }
  if (type) { where.push('b.type = ?'); params.push(type); }
  if (source) { where.push('b.source = ?'); params.push(source); }
  if (q) {
    where.push('(b.topic LIKE ? OR b.tags LIKE ? OR b.payload LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await db.query(
    `SELECT b.id, b.module, b.type, b.topic, b.difficulty, b.tags, b.source, b.created_at,
            b.payload, u.name AS creator
       FROM question_bank b LEFT JOIN users u ON u.id = b.created_by
       ${clause} ORDER BY b.id DESC LIMIT 500`,
    params
  );
  const items = rows.map((r) => {
    let payload = {};
    try { payload = JSON.parse(r.payload); } catch { /* 壞掉的資料照樣列出來讓人刪掉 */ }
    const { payload: _drop, ...rest } = r;
    return { ...rest, questionCount: countQuestions(payload), broken: !payload.group && !payload.groups };
  });
  // 給前端做篩選下拉用的統計
  const stats = await db.query(
    'SELECT module, type, COUNT(*) AS n FROM question_bank GROUP BY module, type ORDER BY module, type'
  );
  const total = await db.one('SELECT COUNT(*) AS n FROM question_bank');
  res.json({ items, stats, total: Number(total?.n || 0) });
});

/* ── 自動組卷 ─────────────────────────────────────────── */

/** 題庫目前有多少料，夠不夠組一份完整試卷 */
router.get('/bank/coverage', requireStaff, async (req, res) => {
  const rows = await db.query('SELECT id, module, type, difficulty, payload FROM question_bank LIMIT 3000');
  const bank = rows.map((r) => {
    let payload = {};
    try { payload = JSON.parse(r.payload); } catch { payload = {}; }
    return { ...r, payload };
  });
  res.json({ coverage: assemble.coverage(bank), total: bank.length, targets: assemble.DEFAULT_TARGETS });
});

/**
 * 自動組卷。預設只做預覽（不存檔），確認後再帶 save=true 存成試卷。
 */
router.post('/bank/auto', requireStaff, async (req, res) => {
  const rows = await db.query('SELECT id, module, type, topic, difficulty, payload FROM question_bank LIMIT 3000');
  if (!rows.length) return res.status(400).json({ error: '題庫是空的，請先用「AI 出題」或「匯入題目」放一些題組進來' });

  const bank = rows.map((r) => {
    let payload = {};
    try { payload = JSON.parse(r.payload); } catch { payload = {}; }
    return { ...r, payload };
  });

  const targets = {};
  for (const m of ['listening', 'reading', 'writing', 'speaking']) {
    const v = Number(req.body?.targets?.[m]);
    if (Number.isFinite(v) && v > 0) targets[m] = Math.min(100, Math.round(v));
  }
  if (!Object.keys(targets).length) Object.assign(targets, assemble.DEFAULT_TARGETS);

  const out = assemble.assemble(bank, {
    title: String(req.body?.title || '').trim() || `自動組卷 ${new Date().toISOString().slice(0, 10)}`,
    testType: req.body?.testType === 'general' ? 'general' : 'academic',
    targets,
    difficulty: String(req.body?.difficulty || ''),
    types: Array.isArray(req.body?.types) && req.body.types.length ? req.body.types : null,
    seed: req.body?.seed != null ? Number(req.body.seed) : null,
  });

  if (!out.paper) return res.status(400).json({ error: out.error || '組不出試卷', report: out.report });

  if (req.body?.save) {
    if (!out.ok) {
      return res.status(400).json({ error: '組出來的試卷格式有誤，請調整條件再試', errors: out.errors, report: out.report });
    }
    const id = await db.insert(
      'INSERT INTO tests (title, test_type, description, content, published, created_by) VALUES (?,?,?,?,0,?)',
      [out.paper.title, out.paper.testType, out.paper.description || null, JSON.stringify(out.paper), req.user.id]
    );
    return res.json({ ok: true, saved: true, testId: id, stats: out.stats, warnings: out.warnings, report: out.report });
  }

  res.json({
    ok: out.ok, errors: out.errors, warnings: out.warnings,
    stats: out.stats, report: out.report, paper: out.paper,
  });
});

router.get('/bank/:id', requireStaff, async (req, res) => {
  const row = await db.one('SELECT * FROM question_bank WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '找不到題組' });
  let payload = {};
  try { payload = JSON.parse(row.payload); } catch { payload = {}; }
  res.json({ item: { ...row, payload } });
});

/** 改標籤 / 主題 / 難度（題目本身要改就重新產生或直接編試卷） */
router.put('/bank/:id', requireStaff, async (req, res) => {
  const row = await db.one('SELECT id FROM question_bank WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '找不到題組' });
  const { topic, difficulty, tags } = req.body || {};
  await db.exec(
    'UPDATE question_bank SET topic = ?, difficulty = ?, tags = ? WHERE id = ?',
    [topic || null, difficulty || null, tags || null, req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/bank/:id', requireStaff, async (req, res) => {
  const row = await db.one('SELECT id FROM question_bank WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '找不到題組' });
  await db.exec('DELETE FROM question_bank WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

/** 批次刪除 */
router.post('/bank/bulk-delete', requireStaff, async (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: '沒有選取任何題組' });
  await db.exec(
    `DELETE FROM question_bank WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  res.json({ ok: true, deleted: ids.length });
});

/**
 * 把題庫裡的題組放進試卷。
 *   testId 有值 → 併進那份現有試卷；沒有 → 用 title 開一份新試卷。
 * 同一個模組的 section 會接在後面，跟匯入的合併規則一致。
 */
router.post('/bank/to-test', requireStaff, async (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: '請先選取要加入的題組' });

  const rows = await db.query(
    `SELECT * FROM question_bank WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  if (!rows.length) return res.status(404).json({ error: '找不到選取的題組' });
  // 照使用者勾選的順序排
  rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

  let base;
  const testId = Number(req.body?.testId) || 0;
  if (testId) {
    const t = await db.one('SELECT * FROM tests WHERE id = ?', [testId]);
    if (!t) return res.status(404).json({ error: '找不到試卷' });
    base = normalizePaper(JSON.parse(t.content));
  } else {
    base = normalizePaper({
      title: String(req.body?.title || '').trim() || '題庫組卷',
      testType: req.body?.testType === 'general' ? 'general' : 'academic',
      modules: [],
    });
  }

  const renumber = req.body?.renumber !== false;
  for (const row of rows) {
    const add = normalizePaper(bankItemToPaper(row));
    for (const mod of add.modules) {
      const exist = base.modules.find((m) => m.module === mod.module);
      if (!exist) { base.modules.push(mod); continue; }
      // 題庫題組的題號都是從 1 開始，直接接上去一定會撞號。
      // 預設自動往後接續，老師就不必手動改一遍題號。
      if (renumber) shiftNumbers(mod.sections, maxNumber(exist.sections));
      exist.sections.push(...mod.sections);
    }
  }

  const result = validatePaper(base);
  if (!result.ok) return res.status(400).json({ error: '組出來的試卷格式有誤', errors: result.errors });

  if (testId) {
    await db.exec('UPDATE tests SET content = ? WHERE id = ?', [JSON.stringify(result.paper), testId]);
    return res.json({ ok: true, testId, added: rows.length, stats: result.stats, warnings: result.warnings });
  }
  const newId = await db.insert(
    'INSERT INTO tests (title, test_type, description, content, published, created_by) VALUES (?,?,?,?,0,?)',
    [result.paper.title, result.paper.testType, '由題庫組成', JSON.stringify(result.paper), req.user.id]
  );
  res.json({ ok: true, testId: newId, created: true, added: rows.length, stats: result.stats, warnings: result.warnings });
});

// ── 單篇寫作立即批改（練習模式，不必整場考試）────────────────
router.post('/grade-writing', aiLimit, aiHeavyLimit, async (req, res) => {
  const { taskNo = 2, prompt, essay, testType = 'academic', minWords } = req.body || {};
  if (!essay || String(essay).trim().length < 20) return res.status(400).json({ error: '請貼上作文內容' });
  try {
    const out = await aiTasks.gradeWriting({
      taskNo: Number(taskNo), prompt: prompt || '', essay, testType,
      minWords: minWords || (Number(taskNo) === 2 ? 250 : 150), userId: req.user.id,
    });
    res.json({ ok: true, result: out });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
