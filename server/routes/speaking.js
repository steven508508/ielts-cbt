'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { requireAuth, requireStaff } = require('../middleware/auth');
const ai = require('../lib/ai');
const aiTasks = require('../lib/aiTasks');
const bands = require('../lib/bands');

const realtime = require('../lib/realtime');

const router = express.Router();
router.use(requireAuth);

/** 目前設定是否支援即時語音對話 */
router.get('/realtime/status', async (req, res) => {
  res.json(await realtime.isAvailable());
});

/** 即時分數（考試中每幾輪更新一次；老師監看頁也讀這支） */
router.get('/:attemptId/live', async (req, res) => {
  const attempt = await db.one('SELECT user_id FROM attempts WHERE id = ?', [req.params.attemptId]);
  if (!attempt) return res.status(404).json({ error: '找不到這場考試' });
  if (attempt.user_id !== req.user.id && req.user.role === 'student')
    return res.status(403).json({ error: '權限不足' });
  const row = await db.one('SELECT * FROM speaking_live WHERE attempt_id = ?', [req.params.attemptId]);
  if (!row) return res.json({ live: null });
  let criteria = null;
  try { criteria = JSON.parse(row.criteria || 'null'); } catch {}
  res.json({
    live: {
      part: row.part, turns: row.turns, band: row.band == null ? null : Number(row.band),
      criteria, note: row.notes, transcript: row.transcript, status: row.status,
      updatedAt: row.updated_at,
    },
  });
});

/** 老師：目前正在進行中的口說考試 */
router.get('/monitor/active', requireStaff, async (req, res) => {
  const rows = await db.query(
    `SELECT l.attempt_id, l.part, l.turns, l.band, l.criteria, l.notes, l.status, l.updated_at,
            u.name AS student_name, u.class_group, t.title AS test_title
     FROM speaking_live l
     JOIN attempts a ON a.id = l.attempt_id
     JOIN users u ON u.id = a.user_id
     JOIN tests t ON t.id = a.test_id
     WHERE l.updated_at > DATE_SUB(NOW(), INTERVAL 2 HOUR)
     ORDER BY l.updated_at DESC LIMIT 50`
  );
  res.json({
    sessions: rows.map((r) => {
      let criteria = null;
      try { criteria = JSON.parse(r.criteria || 'null'); } catch {}
      return { ...r, criteria, band: r.band == null ? null : Number(r.band) };
    }),
  });
});

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

/** 考官語音（TTS）。失敗時前端會自動改用瀏覽器內建語音。 */
router.post('/tts', async (req, res) => {
  const { text, voice } = req.body || {};
  if (!text) return res.status(400).json({ error: '沒有文字' });
  try {
    const buf = await ai.speak(String(text).slice(0, 3000), { voice, userId: req.user.id });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(503).json({ error: e.message, fallback: 'browser' });
  }
});

/** 上傳一題的錄音，順便做語音轉文字 */
router.post('/:attemptId/response', memUpload.single('audio'), async (req, res) => {
  const attempt = await db.one('SELECT * FROM attempts WHERE id = ?', [req.params.attemptId]);
  if (!attempt) return res.status(404).json({ error: '找不到這場考試' });
  if (attempt.user_id !== req.user.id && req.user.role === 'student')
    return res.status(403).json({ error: '權限不足' });

  const part = Number(req.body.part || 1);
  const qIndex = Number(req.body.qIndex || 0);
  const question = req.body.question || '';
  const duration = Number(req.body.duration || 0);
  let transcript = req.body.transcript || '';           // 前端指定的逐字稿（優先）
  const browserText = req.body.browserTranscript || ''; // 瀏覽器語音辨識的備援
  let audioPath = null;

  if (req.file) {
    const dir = path.join(config.UPLOAD_DIR, 'speaking', String(attempt.id));
    fs.mkdirSync(dir, { recursive: true });
    const ext = (req.file.originalname.match(/\.\w+$/) || ['.webm'])[0];
    const fname = `p${part}_q${qIndex}${ext}`;
    fs.writeFileSync(path.join(dir, fname), req.file.buffer);
    audioPath = `/uploads/speaking/${attempt.id}/${fname}`;

    if (!transcript) {
      try {
        transcript = await ai.transcribe(req.file.buffer, `p${part}q${qIndex}${ext}`, { userId: req.user.id });
      } catch (e) {
        // 伺服器端沒有 STT 或呼叫失敗 → 退回瀏覽器辨識的結果
        transcript = browserText;
        res.locals.sttError = e.message;
      }
    }
  }
  if (!transcript) transcript = browserText;

  await db.exec(
    `INSERT INTO speaking_responses (attempt_id, part, q_index, question, audio_path, transcript, duration_sec)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE question=VALUES(question), audio_path=COALESCE(VALUES(audio_path), audio_path),
       transcript=VALUES(transcript), duration_sec=VALUES(duration_sec)`,
    [attempt.id, part, qIndex, question, audioPath, transcript, duration]
  );

  res.json({ ok: true, transcript, audioPath, sttError: res.locals.sttError || null });
});

/** 整場備份錄音（供老師事後聆聽） */
router.post('/:attemptId/recording', memUpload.single('audio'), async (req, res) => {
  const attempt = await db.one('SELECT * FROM attempts WHERE id = ?', [req.params.attemptId]);
  if (!attempt) return res.status(404).json({ error: '找不到這場考試' });
  if (attempt.user_id !== req.user.id && req.user.role === 'student')
    return res.status(403).json({ error: '權限不足' });
  if (!req.file) return res.status(400).json({ error: '沒有檔案' });

  const dir = path.join(config.UPLOAD_DIR, 'speaking', String(attempt.id));
  fs.mkdirSync(dir, { recursive: true });
  const ext = (req.file.originalname.match(/\.\w+$/) || ['.webm'])[0];
  fs.writeFileSync(path.join(dir, `full-interview${ext}`), req.file.buffer);
  const p = `/uploads/speaking/${attempt.id}/full-interview${ext}`;

  await db.exec(
    `INSERT INTO speaking_responses (attempt_id, part, q_index, question, audio_path, transcript, duration_sec)
     VALUES (?,0,0,'整場錄音',?, '', 0)
     ON DUPLICATE KEY UPDATE audio_path=VALUES(audio_path)`,
    [attempt.id, p]
  );
  res.json({ ok: true, audioPath: p });
});

/** 輪替模式的即時評分：每答完一題呼叫一次 */
router.post('/:attemptId/score-now', async (req, res) => {
  const attempt = await db.one('SELECT * FROM attempts WHERE id = ?', [req.params.attemptId]);
  if (!attempt) return res.status(404).json({ error: '找不到這場考試' });
  if (attempt.user_id !== req.user.id && req.user.role === 'student')
    return res.status(403).json({ error: '權限不足' });

  const rows = await db.query(
    'SELECT part, q_index, question, transcript, duration_sec FROM speaking_responses WHERE attempt_id = ? AND part > 0 ORDER BY part, q_index',
    [attempt.id]
  );
  const withText = rows.filter((r) => String(r.transcript || '').trim());
  if (withText.length < 2) return res.json({ live: null, reason: '資料還太少' });

  const transcript = withText
    .map((r) => `EXAMINER: ${r.question || ''}\nCANDIDATE: ${r.transcript}`).join('\n');
  const seconds = withText.reduce((n, r) => n + (r.duration_sec || 0), 0);

  try {
    const out = await aiTasks.scoreSpeakingLive({ transcript, seconds, userId: req.user.id });
    const band = out.band != null ? bands.roundHalfBand(Number(out.band)) : bands.criteriaToBand(out.criteria);
    await db.exec(
      `INSERT INTO speaking_live (attempt_id, part, turns, criteria, band, notes, transcript, status)
       VALUES (?,?,?,?,?,?,?, 'live')
       ON DUPLICATE KEY UPDATE part=VALUES(part), turns=VALUES(turns), criteria=VALUES(criteria),
         band=VALUES(band), notes=VALUES(notes), transcript=VALUES(transcript), status='live'`,
      [attempt.id, withText[withText.length - 1].part, withText.length,
       JSON.stringify(out.criteria || {}), band, out.note_zh || '', transcript]
    );
    res.json({ live: { band, criteria: out.criteria, note: out.note_zh } });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/** 輪替模式結束：立刻算出口說正式分數 */
router.post('/:attemptId/finalize', async (req, res) => {
  const attempt = await db.one('SELECT * FROM attempts WHERE id = ?', [req.params.attemptId]);
  if (!attempt) return res.status(404).json({ error: '找不到這場考試' });
  if (attempt.user_id !== req.user.id && req.user.role === 'student')
    return res.status(403).json({ error: '權限不足' });

  const assignment = attempt.assignment_id
    ? await db.one('SELECT speaking_grading FROM assignments WHERE id = ?', [attempt.assignment_id])
    : null;
  if ((assignment?.speaking_grading || 'ai') !== 'ai') {
    await db.exec(
      `INSERT INTO module_results (attempt_id, module, band, feedback, graded_by) VALUES (?,'speaking',NULL,?, 'pending')
       ON DUPLICATE KEY UPDATE feedback=VALUES(feedback), graded_by='pending'`,
      [attempt.id, JSON.stringify({ pending: true, note: '等待老師人工評分' })]
    );
    return res.json({ pending: true });
  }

  const responses = await db.query(
    'SELECT part, q_index, question, transcript, duration_sec FROM speaking_responses WHERE attempt_id = ? AND part > 0 ORDER BY part, q_index',
    [attempt.id]
  );
  if (!responses.length) return res.json({ band: null });
  try {
    const graded = await aiTasks.gradeSpeaking({ responses, userId: req.user.id });
    const band = graded.band != null ? bands.roundHalfBand(Number(graded.band)) : bands.criteriaToBand(graded.criteria);
    await db.exec(
      `INSERT INTO module_results (attempt_id, module, band, criteria, feedback, graded_by, graded_at)
       VALUES (?,'speaking',?,?,?, 'ai', NOW())
       ON DUPLICATE KEY UPDATE band=VALUES(band), criteria=VALUES(criteria),
         feedback=VALUES(feedback), graded_by='ai', graded_at=NOW()`,
      [attempt.id, band, JSON.stringify(graded.criteria || {}), JSON.stringify(graded)]
    );
    await db.exec(
      `INSERT INTO speaking_live (attempt_id, criteria, band, status) VALUES (?,?,?, 'final')
       ON DUPLICATE KEY UPDATE criteria=VALUES(criteria), band=VALUES(band), status='final'`,
      [attempt.id, JSON.stringify(graded.criteria || {}), band]
    );
    res.json({ band, criteria: graded.criteria, feedback: graded });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/** 依考生回答動態追問（Part 1 / Part 3） */
router.post('/:attemptId/follow-up', async (req, res) => {
  const { part, topic, history } = req.body || {};
  try {
    const question = await aiTasks.speakingFollowUp({
      part: Number(part) || 1, topic: topic || '', history: history || [], userId: req.user.id,
    });
    res.json({ question });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/** 老師／學生查看口說逐字稿與錄音 */
router.get('/:attemptId/responses', async (req, res) => {
  const attempt = await db.one('SELECT * FROM attempts WHERE id = ?', [req.params.attemptId]);
  if (!attempt) return res.status(404).json({ error: '找不到這場考試' });
  if (attempt.user_id !== req.user.id && req.user.role === 'student')
    return res.status(403).json({ error: '權限不足' });
  const rows = await db.query(
    'SELECT part, q_index, question, transcript, duration_sec, audio_path FROM speaking_responses WHERE attempt_id = ? ORDER BY part, q_index',
    [attempt.id]
  );
  res.json({ responses: rows });
});

module.exports = router;
