'use strict';
/**
 * 學生自學：錯題複習、題型練習、口說單獨練習。
 *
 * 這些都不算「正式考試」，不會產生成績、也不會寫進 attempts，
 * 純粹讓學生自己練。錯題來源是自己考過而且已批改的場次。
 */
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { normalizePaper, flattenQuestions, QUESTION_TYPES } = require('../lib/paper');
const { checkAnswer } = require('../lib/answers');
const ai = require('../lib/ai');
const aiTasks = require('../lib/aiTasks');

const router = express.Router();
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

router.use(requireAuth);

/** 學生只能碰自己的資料；老師想看別人的要明確指定 userId */
function targetUser(req) {
  const asked = Number(req.query.userId || req.body?.userId || 0);
  if (asked && req.user.role !== 'student') return asked;
  return req.user.id;
}

/** answers.expected 是 JSON.stringify 過的陣列，還原成人看得懂的字串 */
function prettyExpected(v) {
  if (!v) return '';
  try {
    const arr = JSON.parse(v);
    if (Array.isArray(arr)) return arr.join(' / ');
  } catch { /* 不是 JSON 就原樣用 */ }
  return String(v);
}

/**
 * 把「答錯的紀錄」還原成完整題目。
 * answers 表只存題號與作答，題幹選項都在試卷 JSON 裡，要對回去。
 */
async function collectWrong(userId, { module: mod, type, limit = 200 } = {}) {
  const rows = await db.query(
    `SELECT an.attempt_id, an.module, an.q_number, an.response, an.expected,
            a.test_id, a.submitted_at, t.title AS test_title, t.content
       FROM answers an
       JOIN attempts a ON a.id = an.attempt_id
       JOIN tests   t ON t.id = a.test_id
      WHERE a.user_id = ? AND a.status = 'graded' AND an.correct = 0
        ${mod ? 'AND an.module = ?' : ''}
      ORDER BY a.submitted_at DESC, an.module, an.q_number
      LIMIT ${Math.min(500, Number(limit) || 200)}`,
    mod ? [userId, mod] : [userId]
  );

  // 同一份試卷只解析一次
  const cache = new Map();
  const items = [];
  for (const r of rows) {
    if (!cache.has(r.test_id)) {
      try {
        const paper = normalizePaper(JSON.parse(r.content));
        const index = new Map();
        for (const m of paper.modules) {
          for (const q of flattenQuestions(paper, m.module)) index.set(`${m.module}:${q.number}`, q);
        }
        cache.set(r.test_id, index);
      } catch { cache.set(r.test_id, new Map()); }
    }
    const q = cache.get(r.test_id).get(`${r.module}:${r.q_number}`);
    if (!q) continue;
    if (type && q.type !== type) continue;
    items.push({
      key: `${r.attempt_id}:${r.module}:${r.q_number}`,
      attemptId: r.attempt_id,
      testTitle: r.test_title,
      submittedAt: r.submitted_at,
      module: r.module,
      number: r.q_number,
      type: q.type,
      instructions: q.instructions || null,
      text: q.text || q.prompt || '',
      options: q.options || q.group?.options || null,
      wordLimit: q.wordLimit ?? q.group?.wordLimit ?? null,
      yourAnswer: r.response || '',
      // answers.expected 存的是 JSON 字串（["FALSE"]），直接顯示會很醜
      expected: prettyExpected(r.expected) || (q.answers || []).join(' / '),
      explanation: q.explanation || null,
      answers: q.answers || [],
    });
  }
  return items;
}

/** 錯題清單（含正解與解析——成績單本來就看得到，這裡是整理過的版本）*/
router.get('/wrong', async (req, res) => {
  const uid = targetUser(req);
  const items = await collectWrong(uid, {
    module: req.query.module, type: req.query.type, limit: req.query.limit,
  });

  // 各題型錯幾題，讓學生知道自己弱在哪
  const all = req.query.module || req.query.type ? await collectWrong(uid, {}) : items;
  const byType = {};
  for (const it of all) byType[it.type] = (byType[it.type] || 0) + 1;

  res.json({
    items,
    total: items.length,
    byType: Object.entries(byType)
      .map(([t, n]) => ({ type: t, label: QUESTION_TYPES[t]?.label || t, wrong: n }))
      .sort((a, b) => b.wrong - a.wrong),
  });
});

/** 重做：抽題目出來，但不給答案 */
router.post('/drill', async (req, res) => {
  const uid = targetUser(req);
  const count = Math.min(50, Math.max(1, Number(req.body?.count) || 10));
  let pool = await collectWrong(uid, { module: req.body?.module, type: req.body?.type, limit: 500 });
  if (!pool.length) return res.status(400).json({ error: '目前沒有符合條件的錯題可以練習' });

  // 依 key 去重（同一題在不同場次錯過好幾次，只留最近一次）
  const seen = new Set();
  pool = pool.filter((it) => {
    const k = `${it.testTitle}:${it.module}:${it.number}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const picked = pool.slice(0, count);
  res.json({
    items: picked.map((it) => ({
      key: it.key, module: it.module, number: it.number, type: it.type,
      instructions: it.instructions, text: it.text, options: it.options,
      wordLimit: it.wordLimit, testTitle: it.testTitle,
      // 這裡刻意不給 answers / expected / explanation
    })),
  });
});

/** 重做批改 */
router.post('/drill/check', async (req, res) => {
  const uid = targetUser(req);
  const responses = req.body?.responses || {};
  const pool = await collectWrong(uid, { limit: 500 });
  const byKey = new Map(pool.map((it) => [it.key, it]));

  const results = [];
  let correct = 0;
  for (const [key, response] of Object.entries(responses)) {
    const it = byKey.get(key);
    if (!it) continue;
    const r = checkAnswer(
      { type: it.type, answers: it.answers, wordLimit: it.wordLimit },
      String(response ?? '')
    );
    if (r.awarded > 0) correct += 1;
    results.push({
      key, correct: r.awarded > 0, awarded: r.awarded,
      yourAnswer: String(response ?? ''),
      expected: (it.answers || []).join(' / '),
      explanation: it.explanation,
      reason: r.reason || null,
    });
  }
  res.json({ results, correct, total: results.length });
});

/* ── 口說單獨練習 ─────────────────────────────────────────────
   不用開整場考試，挑一個 Part 就能練。
   出題優先用已發布試卷裡現成的口說題；沒有的話再請 AI 生一組。 */

const FALLBACK_TOPICS = {
  1: [
    { topic: 'Hometown', items: ['Where is your hometown?', 'What do you like most about it?', 'Has it changed much in recent years?', 'Would you like to live there in the future?'] },
    { topic: 'Free time', items: ['What do you usually do in your free time?', 'Do you prefer being indoors or outdoors?', 'Has the way you spend your free time changed?', 'Who do you usually spend your free time with?'] },
  ],
  2: [
    { cueCard: { topic: 'Describe a skill you would like to learn.', bullets: ['You should say:', 'what the skill is', 'how you would learn it', 'why it interests you', 'and explain how it would change your life.'], prepSec: 60, talkSec: 120 } },
  ],
  3: [
    { topic: 'Learning and society', items: ['Why do some adults find it hard to learn new skills?', 'Should schools teach more practical skills?', 'How has technology changed the way people learn?', 'Do you think formal qualifications still matter?', 'Will traditional classrooms disappear?', 'Who should pay for adult education?'] },
  ],
};

/** 出一題口說 */
router.post('/speaking/question', async (req, res) => {
  const part = [1, 2, 3].includes(Number(req.body?.part)) ? Number(req.body.part) : 2;
  const topic = String(req.body?.topic || '').slice(0, 100);

  // ① 先找現成的（已發布試卷裡的口說題組）
  if (!topic) {
    const rows = await db.query(
      "SELECT content FROM tests WHERE published = 1 AND content LIKE '%speaking_part%' ORDER BY RAND() LIMIT 5"
    );
    const found = [];
    for (const r of rows) {
      try {
        const paper = normalizePaper(JSON.parse(r.content));
        const mod = paper.modules.find((m) => m.module === 'speaking');
        for (const sec of mod?.sections || []) {
          for (const g of sec.groups || []) {
            for (const q of g.questions || []) {
              if (Number(q.part) === part) found.push(q);
            }
          }
        }
      } catch { /* 跳過壞掉的試卷 */ }
    }
    if (found.length) {
      const q = found[Math.floor(Math.random() * found.length)];
      return res.json({ part, source: 'bank', question: q });
    }
  }

  // ② 請 AI 出一組
  try {
    const set = await aiTasks.generateSpeakingSet({ theme: topic, userId: req.user.id });
    const qs = set?.groups?.[0]?.questions || [];
    const pick = qs.filter((q) => Number(q.part) === part);
    if (pick.length) {
      return res.json({ part, source: 'ai', question: pick[Math.floor(Math.random() * pick.length)] });
    }
  } catch (e) {
    // AI 沒設定或失敗 → 用內建題庫，不要讓學生練不了
    console.warn('[practice] 口說出題失敗，改用內建題目：', e.message);
  }

  const pool = FALLBACK_TOPICS[part] || FALLBACK_TOPICS[1];
  res.json({ part, source: 'builtin', question: pool[Math.floor(Math.random() * pool.length)] });
});

/** 批改一次口說練習：可以送錄音檔，也可以直接送逐字稿 */
router.post('/speaking/grade', memUpload.single('audio'), async (req, res) => {
  const part = Number(req.body?.part || 1);
  const question = String(req.body?.question || '').slice(0, 2000);
  const duration = Number(req.body?.duration || 0);
  let transcript = String(req.body?.transcript || '');
  let sttError = null;

  if (!transcript && req.file) {
    try {
      transcript = await ai.transcribe(req.file.buffer, 'practice.webm', { userId: req.user.id });
    } catch (e) {
      sttError = ai.friendlyError(e);
    }
  }
  if (!transcript.trim()) {
    return res.status(400).json({
      error: sttError
        ? `沒有拿到逐字稿：${sttError}`
        : '沒有收到你的回答。請錄音，或直接把回答打成文字。',
    });
  }

  try {
    const result = await aiTasks.gradeSpeaking({
      responses: [{ part, q_index: 0, question, transcript, duration_sec: duration }],
      userId: req.user.id,
    });
    res.json({ ok: true, transcript, duration, result, sttError });
  } catch (e) {
    res.status(502).json({ error: ai.friendlyError(e), transcript });
  }
});

module.exports = router;
