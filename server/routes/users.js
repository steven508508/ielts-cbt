'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireStaff, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireStaff);

router.get('/', async (req, res) => {
  const { role, classGroup, q } = req.query;
  const where = [];
  const params = [];
  if (role) { where.push('role = ?'); params.push(role); }
  if (classGroup) { where.push('class_group = ?'); params.push(classGroup); }
  if (q) { where.push('(username LIKE ? OR name LIKE ? OR candidate_no LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = await db.query(
    `SELECT id, username, name, email, role, class_group, candidate_no, date_of_birth, nationality, active, created_at
     FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY class_group, name`,
    params
  );
  res.json({ users: rows });
});

router.get('/classes', async (req, res) => {
  const rows = await db.query(
    "SELECT class_group AS name, COUNT(*) AS n FROM users WHERE role='student' AND class_group IS NOT NULL AND class_group <> '' GROUP BY class_group ORDER BY class_group"
  );
  res.json({ classes: rows });
});

router.post('/', async (req, res) => {
  const { username, password, name, role = 'student', email, classGroup, candidateNo, dateOfBirth, nationality } = req.body || {};
  if (!username || !password || !name) return res.status(400).json({ error: '帳號、密碼、姓名為必填' });
  if (role !== 'student' && req.user.role !== 'admin')
    return res.status(403).json({ error: '只有管理員能建立老師或管理員帳號' });
  const dup = await db.one('SELECT id FROM users WHERE username = ?', [username]);
  if (dup) return res.status(409).json({ error: `帳號 ${username} 已存在` });
  const id = await db.insert(
    `INSERT INTO users (username, password_hash, name, email, role, class_group, candidate_no, date_of_birth, nationality)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [username, await bcrypt.hash(String(password), 10), name, email || null, role,
     classGroup || null, candidateNo || null, dateOfBirth || null, nationality || null]
  );
  res.json({ id });
});

/** 批次建立學生：貼一行一位「姓名,帳號,密碼,班級,考生編號」 */
router.post('/bulk', async (req, res) => {
  const { text, defaultPassword = 'ielts1234', classGroup = '' } = req.body || {};
  if (!text) return res.status(400).json({ error: '沒有內容' });
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const created = [];
  const skipped = [];
  for (const line of lines) {
    const parts = line.split(/\s*[,\t，]\s*/);
    const name = parts[0];
    if (!name) continue;
    let username = parts[1] || '';
    const password = parts[2] || defaultPassword;
    const cls = parts[3] || classGroup || null;
    const candNo = parts[4] || null;
    if (!username) {
      username = `s${Date.now().toString(36)}${created.length}`;
    }
    const dup = await db.one('SELECT id FROM users WHERE username = ?', [username]);
    if (dup) { skipped.push(`${name} (${username} 已存在)`); continue; }
    await db.insert(
      `INSERT INTO users (username, password_hash, name, role, class_group, candidate_no)
       VALUES (?,?,?,'student',?,?)`,
      [username, await bcrypt.hash(String(password), 10), name, cls, candNo]
    );
    created.push({ name, username, password, classGroup: cls });
  }
  res.json({ created, skipped });
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const target = await db.one('SELECT * FROM users WHERE id = ?', [id]);
  if (!target) return res.status(404).json({ error: '找不到使用者' });
  if (target.role !== 'student' && req.user.role !== 'admin')
    return res.status(403).json({ error: '只有管理員能修改老師或管理員帳號' });

  const f = req.body || {};
  const sets = [];
  const params = [];
  const map = {
    name: 'name', email: 'email', classGroup: 'class_group', candidateNo: 'candidate_no',
    dateOfBirth: 'date_of_birth', nationality: 'nationality',
  };
  for (const [k, col] of Object.entries(map)) {
    if (f[k] !== undefined) { sets.push(`${col} = ?`); params.push(f[k] || null); }
  }
  if (f.active !== undefined) { sets.push('active = ?'); params.push(f.active ? 1 : 0); }
  if (f.role !== undefined && req.user.role === 'admin') { sets.push('role = ?'); params.push(f.role); }
  if (f.password) { sets.push('password_hash = ?'); params.push(await bcrypt.hash(String(f.password), 10)); }
  if (!sets.length) return res.json({ ok: true });
  params.push(id);
  await db.exec(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json({ ok: true });
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能刪除自己' });
  await db.exec('DELETE FROM users WHERE id = ?', [id]);
  res.json({ ok: true });
});

module.exports = router;
