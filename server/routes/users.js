'use strict';
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const retention = require('../lib/retention');
const { requireAuth, requireStaff, requireRole } = require('../middleware/auth');
const scope = require('../lib/scope');

const router = express.Router();
router.use(requireAuth, requireStaff);

const ROLES = ['admin', 'teacher', 'student'];

/** 目前還有幾個「啟用中的管理員」——用來防止把自己鎖在門外 */
async function activeAdminCount(excludeId = null) {
  const row = await db.one(
    `SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 ${excludeId ? 'AND id <> ?' : ''}`,
    excludeId ? [excludeId] : []
  );
  return Number(row?.n || 0);
}

router.get('/', async (req, res) => {
  const { role, classGroup, q, active } = req.query;
  const where = [];
  const params = [];
  // role 可以一次帶多個，例如 ?role=admin,teacher
  const roles = String(role || '').split(',').map((r) => r.trim()).filter((r) => ROLES.includes(r));
  if (roles.length) { where.push(`role IN (${roles.map(() => '?').join(',')})`); params.push(...roles); }
  if (classGroup) { where.push('class_group = ?'); params.push(classGroup); }
  if (active === '0' || active === '1') { where.push('active = ?'); params.push(Number(active)); }
  if (q) {
    where.push('(username LIKE ? OR name LIKE ? OR candidate_no LIKE ? OR email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  /* 班級隔離：被指定班級的老師只看得到自己班的學生。
     教職員（老師／管理員）不屬於任何班級 —— 受限的老師看不到他們，
     否則等於把全校的教職員名冊連 email 一起攤開給每一位老師。 */
  const mine = await scope.classesOf(req.user);
  if (mine !== null) {
    where.push("u.role = 'student'");
    if (mine.length) { where.push(`u.class_group IN (${mine.map(() => '?').join(',')})`); params.push(...mine); }
    else where.push('1=0');
  }
  const rows = await db.query(
    `SELECT u.id, u.username, u.name, u.email, u.role, u.class_group, u.candidate_no,
            u.date_of_birth, u.nationality, u.active, u.created_at,
            (SELECT COUNT(*) FROM attempts a WHERE a.user_id = u.id) AS attempts,
            (SELECT COUNT(*) FROM tests t WHERE t.created_by = u.id) AS tests_created
     FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY FIELD(u.role,'admin','teacher','student'), u.class_group, u.name`,
    params
  );
  // 老師的管轄班級一次帶出來（成員清單要顯示）
  const teacherIds = rows.filter((r) => r.role === 'teacher').map((r) => r.id);
  const byTeacher = await scope.classesForMany(teacherIds);
  for (const r of rows) if (r.role === 'teacher') r.manages = byTeacher[r.id] || [];

  const summary = await db.query(
    'SELECT role, COUNT(*) AS n, SUM(active) AS active FROM users GROUP BY role'
  );
  res.json({
    users: rows,
    summary: Object.fromEntries(summary.map((s) => [s.role, { total: Number(s.n), active: Number(s.active) }])),
    adminCount: await activeAdminCount(),
    myClasses: mine,          // null = 全校
  });
});

router.get('/classes', async (req, res) => {
  const f = await scope.classFilter(req.user, 'class_group');
  const rows = await db.query(
    `SELECT class_group AS name, COUNT(*) AS n FROM users
      WHERE role='student' AND class_group IS NOT NULL AND class_group <> '' ${f.sql}
      GROUP BY class_group ORDER BY class_group`, f.params
  );
  // 管理員設定老師時要看得到全部班級，不受自己的（不存在的）限制影響
  const all = req.user.role === 'admin' ? rows : await db.query(
    "SELECT class_group AS name, COUNT(*) AS n FROM users WHERE role='student' AND class_group IS NOT NULL AND class_group <> '' GROUP BY class_group ORDER BY class_group"
  );
  res.json({ classes: rows, allClasses: all, myClasses: await scope.classesOf(req.user) });
});

router.post('/', async (req, res) => {
  const { username, password, name, role = 'student', email, classGroup, candidateNo, dateOfBirth, nationality } = req.body || {};
  if (!username || !password || !name) return res.status(400).json({ error: '帳號、密碼、姓名為必填' });
  if (role !== 'student' && req.user.role !== 'admin')
    return res.status(403).json({ error: '只有管理員能建立老師或管理員帳號' });
  // 受限的老師只能把學生加進自己管的班
  if (role === 'student' && !(await scope.canSeeClass(req.user, classGroup))) {
    const mine = await scope.classesOf(req.user);
    return res.status(403).json({ error: `你只能新增這些班級的學生：${(mine || []).join('、')}` });
  }
  const dup = await db.one('SELECT id FROM users WHERE username = ?', [username]);
  if (dup) return res.status(409).json({ error: `帳號 ${username} 已存在` });
  const id = await db.insert(
    `INSERT INTO users (username, password_hash, name, email, role, class_group, candidate_no, date_of_birth, nationality)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [username, await bcrypt.hash(String(password), 10), name, email || null, role,
     classGroup || null, candidateNo || null, dateOfBirth || null, nationality || null]
  );
  // 建立老師時可以直接指定他管哪些班（空的 = 全校，例如科目負責人）
  if (role === 'teacher' && Array.isArray(req.body.manages)) {
    await scope.setClasses(id, req.body.manages);
  }
  res.json({ id });
});

/** 批次建立學生：貼一行一位「姓名,帳號,密碼,班級,考生編號」 */
router.post('/bulk', async (req, res) => {
  const { text, defaultPassword = 'ielts1234', classGroup = '' } = req.body || {};
  if (!text) return res.status(400).json({ error: '沒有內容' });
  const mineB = await scope.classesOf(req.user);
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
    // 每一行都可以自帶班級，所以要逐行檢查，不能只看預設值
    if (mineB !== null && !mineB.includes(String(cls || ''))) {
      skipped.push(`${name}（${cls || '未指定班級'} 不在你管理的班級內）`); continue;
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
  if (!(await scope.canSeeUser(req.user, id)) && req.user.role !== 'admin')
    return res.status(403).json({ error: '這位學生不在你管理的班級內' });

  const f = req.body || {};
  // 也不能把學生「搬」到自己管不到的班去
  if (f.classGroup !== undefined && !(await scope.canSeeClass(req.user, f.classGroup)))
    return res.status(403).json({ error: '不能把學生移到你沒有管理的班級' });
  const sets = [];
  const params = [];
  const map = {
    name: 'name', email: 'email', classGroup: 'class_group', candidateNo: 'candidate_no',
    dateOfBirth: 'date_of_birth', nationality: 'nationality',
  };
  for (const [k, col] of Object.entries(map)) {
    if (f[k] !== undefined) { sets.push(`${col} = ?`); params.push(f[k] || null); }
  }
  // 防呆：不能把最後一個管理員停用或降級，否則沒人能再進後台
  const losingAdmin = target.role === 'admin'
    && ((f.active !== undefined && !f.active) || (f.role !== undefined && f.role !== 'admin'));
  if (losingAdmin && (await activeAdminCount(id)) === 0) {
    return res.status(400).json({
      error: '這是系統裡最後一位啟用中的管理員，不能停用或降級。請先指派另一位管理員。',
    });
  }
  if (f.role !== undefined && !ROLES.includes(f.role)) {
    return res.status(400).json({ error: '角色必須是 admin / teacher / student 其中之一' });
  }

  if (f.active !== undefined) { sets.push('active = ?'); params.push(f.active ? 1 : 0); }
  if (f.role !== undefined && req.user.role === 'admin') { sets.push('role = ?'); params.push(f.role); }
  if (f.username !== undefined && req.user.role === 'admin') {
    const uname = String(f.username).trim();
    if (uname && uname !== target.username) {
      const dup = await db.one('SELECT id FROM users WHERE username = ? AND id <> ?', [uname, id]);
      if (dup) return res.status(409).json({ error: `帳號 ${uname} 已經有人用了` });
      sets.push('username = ?'); params.push(uname);
    }
  }
  if (f.password) {
    if (String(f.password).length < 6) return res.status(400).json({ error: '密碼至少 6 個字元' });
    sets.push('password_hash = ?'); params.push(await bcrypt.hash(String(f.password), 10));
    /* 管理員替人重設密碼，就是要把對方（或盜用者）手上的舊 token 一起收掉。
       以前不會 —— 帳號被盜、管理員重設密碼，攻擊者照樣可以用滿 12 小時。 */
    sets.push('token_version = token_version + 1');
  }
  if (Array.isArray(f.manages) && req.user.role === 'admin') {
    await scope.setClasses(id, f.manages);
  }
  if (!sets.length) return res.json({ ok: true });
  params.push(id);
  await db.exec(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json({ ok: true });
});

/** 刪除前先看看會連帶失去什麼 */
router.get('/:id/impact', async (req, res) => {
  const id = Number(req.params.id);
  const user = await db.one('SELECT id, username, name, role FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ error: '找不到使用者' });
  if (user.role === 'student' && !(await scope.canSeeUser(req.user, id)))
    return res.status(403).json({ error: '這位學生不在你管理的班級內' });
  const [att, tests, asg] = await Promise.all([
    db.one('SELECT COUNT(*) AS n FROM attempts WHERE user_id = ?', [id]),
    db.one('SELECT COUNT(*) AS n FROM tests WHERE created_by = ?', [id]),
    db.one('SELECT COUNT(*) AS n FROM assignments WHERE user_id = ?', [id]),
  ]);
  res.json({
    user,
    attempts: Number(att?.n || 0),        // 會一起刪掉（含作答、作文、口說錄音）
    assignments: Number(asg?.n || 0),     // 會一起刪掉
    testsCreated: Number(tests?.n || 0),  // 不會刪，只會把「建立者」清空
    isLastAdmin: user.role === 'admin' && (await activeAdminCount(id)) === 0,
  });
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能刪除自己' });

  const target = await db.one('SELECT id, username, name, role FROM users WHERE id = ?', [id]);
  if (!target) return res.status(404).json({ error: '找不到使用者' });

  if (target.role === 'admin' && (await activeAdminCount(id)) === 0) {
    return res.status(400).json({
      error: '這是系統裡最後一位啟用中的管理員，不能刪除。請先指派另一位管理員。',
    });
  }

  // 先把這個人的考試場次找出來，順手清掉磁碟上的口說錄音，免得留下孤兒檔案
  const attempts = await db.query('SELECT id FROM attempts WHERE user_id = ?', [id]);
  let freed = 0;
  for (const a of attempts) {
    freed += retention.rmrf(path.join(config.UPLOAD_DIR, 'speaking', String(a.id)));
  }

  await db.exec('DELETE FROM users WHERE id = ?', [id]);
  await db.exec(
    'INSERT INTO maintenance_log (action, detail, affected, freed_bytes, actor) VALUES (?,?,?,?,?)',
    ['user_delete', JSON.stringify({ username: target.username, name: target.name, role: target.role, attempts: attempts.length }),
     1, freed, req.user.username]
  );
  res.json({ ok: true, deletedAttempts: attempts.length, freedBytes: freed });
});

/** 批次啟用 / 停用 / 刪除 */
router.post('/bulk-action', async (req, res) => {
  const { action, ids } = req.body || {};
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) return res.status(400).json({ error: '沒有選取任何成員' });
  if (list.includes(req.user.id)) return res.status(400).json({ error: '不能對自己的帳號做批次操作' });

  const targets = await db.query(
    `SELECT id, username, name, role FROM users WHERE id IN (${list.map(() => '?').join(',')})`, list
  );
  const staffTargets = targets.filter((t) => t.role !== 'student');
  if (staffTargets.length && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只有管理員能操作老師或管理員帳號' });
  }
  /* 整批都要在範圍內，否則整批拒絕。做一半再回報「成功」的話，
     老師會以為全部都處理好了。 */
  const chk = await scope.assertUsers(req.user, list);
  if (!chk.ok) return res.status(403).json({ error: chk.error });

  if (action === 'activate' || action === 'deactivate') {
    const val = action === 'activate' ? 1 : 0;
    if (val === 0) {
      const admins = targets.filter((t) => t.role === 'admin').map((t) => t.id);
      if (admins.length) {
        const row = await db.one(
          `SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id NOT IN (${admins.map(() => '?').join(',')})`,
          admins
        );
        if (Number(row?.n || 0) === 0) {
          return res.status(400).json({ error: '這樣會停用掉所有管理員，系統將沒有人能進入後台。' });
        }
      }
    }
    await db.exec(`UPDATE users SET active = ? WHERE id IN (${list.map(() => '?').join(',')})`, [val, ...list]);
    return res.json({ ok: true, affected: targets.length });
  }

  if (action === 'delete') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '只有管理員能刪除成員' });
    const admins = targets.filter((t) => t.role === 'admin').map((t) => t.id);
    if (admins.length) {
      const row = await db.one(
        `SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id NOT IN (${admins.map(() => '?').join(',')})`,
        admins
      );
      if (Number(row?.n || 0) === 0) {
        return res.status(400).json({ error: '這樣會刪掉所有管理員，系統將沒有人能進入後台。' });
      }
    }
    if (targets.length > 10 && !req.body.force) {
      return res.status(409).json({
        error: `這會刪除 ${targets.length} 位成員以及他們全部的考試紀錄，且無法復原。`,
        affected: targets.length, needsForce: true,
      });
    }

    const attempts = await db.query(
      `SELECT id FROM attempts WHERE user_id IN (${list.map(() => '?').join(',')})`, list
    );
    let freed = 0;
    for (const a of attempts) freed += retention.rmrf(path.join(config.UPLOAD_DIR, 'speaking', String(a.id)));
    await db.exec(`DELETE FROM users WHERE id IN (${list.map(() => '?').join(',')})`, list);
    await db.exec(
      'INSERT INTO maintenance_log (action, detail, affected, freed_bytes, actor) VALUES (?,?,?,?,?)',
      ['users_delete', JSON.stringify(targets.map((t) => `${t.name}(${t.username})`).slice(0, 50)),
       targets.length, freed, req.user.username]
    );
    return res.json({ ok: true, deleted: targets.length, deletedAttempts: attempts.length, freedBytes: freed });
  }

  res.status(400).json({ error: '未知的動作' });
});

module.exports = router;
