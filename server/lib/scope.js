'use strict';
/* 班級隔離。
 *
 * 老師可以被指定管理一或多個班級（teacher_classes）。
 *
 * **沒有指定任何班級 = 全校範圍**，這是刻意的：
 *   · 升級之前就存在的老師帳號不會突然被鎖在外面（考試期間中斷是大事）
 *   · 科目負責人、教務、代課老師這種本來就跨班的角色，不指定就好
 * 要限制誰，就明確給他班級。真的要讓某個帳號完全看不到東西，
 * 應該用「停用帳號」而不是給他零個班級。
 *
 * 管理員永遠不受限制。
 */
const db = require('../db');

/** 這個人管哪些班？回 null 表示不受限制（管理員、或沒指定班級的老師）。 */
async function classesOf(user) {
  if (!user) return [];
  if (user.role === 'admin') return null;
  if (user.role !== 'teacher') return [];          // 學生不該走到這裡
  const rows = await db.query(
    'SELECT class_group FROM teacher_classes WHERE user_id = ? ORDER BY class_group', [user.id]);
  const list = (rows || []).map((r) => r.class_group).filter(Boolean);
  return list.length ? list : null;                 // 沒指定 = 全校
}

/** 這個人是不是被限制在某幾個班？ */
const isScoped = async (user) => (await classesOf(user)) !== null;

/**
 * 產生 SQL 片段。
 *
 * 回 { sql, params }。不受限制時 sql 是空字串，呼叫端直接串起來就好，
 * 不用到處寫 if。col 要是「學生的班級」那一欄的完整名稱。
 */
async function classFilter(user, col = 'u.class_group') {
  const list = await classesOf(user);
  if (list === null) return { sql: '', params: [] };
  if (!list.length) return { sql: ' AND 1=0 ', params: [] };
  return { sql: ` AND ${col} IN (${list.map(() => '?').join(',')}) `, params: list };
}

/** 這個班在不在範圍內？ */
async function canSeeClass(user, classGroup) {
  const list = await classesOf(user);
  if (list === null) return true;
  return list.includes(String(classGroup || ''));
}

/** 這個使用者（通常是學生）在不在範圍內？ */
async function canSeeUser(user, targetId) {
  const list = await classesOf(user);
  if (list === null) return true;
  const t = await db.one('SELECT id, role, class_group FROM users WHERE id = ?', [Number(targetId)]);
  if (!t) return false;
  // 老師與管理員不屬於任何班級 —— 受限的老師不該去動別的教職員
  if (t.role !== 'student') return false;
  return list.includes(String(t.class_group || ''));
}

/** 這場考試（attempt）的考生在不在範圍內？ */
async function canSeeAttempt(user, attemptId) {
  const list = await classesOf(user);
  if (list === null) return true;
  const row = await db.one(
    `SELECT u.class_group FROM attempts a JOIN users u ON u.id = a.user_id WHERE a.id = ?`,
    [Number(attemptId)]);
  if (!row) return false;
  return list.includes(String(row.class_group || ''));
}

/**
 * 一整批學生 id 都要在範圍內，否則整批拒絕。
 * 指派考試、批次動作都走這裡 —— 不可以「只做得到的那幾筆」，
 * 那會讓老師以為全部都成功了。
 */
async function assertUsers(user, ids) {
  const list = await classesOf(user);
  if (list === null) return { ok: true };
  const nums = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!nums.length) return { ok: true };
  const rows = await db.query(
    `SELECT id, name, class_group, role FROM users WHERE id IN (${nums.map(() => '?').join(',')})`, nums);
  const bad = (rows || []).filter((r) => r.role !== 'student' || !list.includes(String(r.class_group || '')));
  if (!bad.length) return { ok: true };
  return {
    ok: false,
    error: `這些人不在你管理的班級內：${bad.map((b) => b.name || b.id).join('、')}`
      + `（你管理：${list.join('、')}）`,
  };
}

/** 設定某位老師管哪些班（傳空陣列 = 全校） */
async function setClasses(userId, classes) {
  const list = [...new Set((classes || []).map((c) => String(c || '').trim()).filter(Boolean))];
  await db.exec('DELETE FROM teacher_classes WHERE user_id = ?', [Number(userId)]);
  for (const c of list) {
    await db.exec('INSERT IGNORE INTO teacher_classes (user_id, class_group) VALUES (?,?)',
      [Number(userId), c.slice(0, 60)]);
  }
  return list;
}

/** 一次讀多位老師的班級（成員清單要用，避免 N+1） */
async function classesForMany(userIds) {
  const nums = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (!nums.length) return {};
  const rows = await db.query(
    `SELECT user_id, class_group FROM teacher_classes WHERE user_id IN (${nums.map(() => '?').join(',')})`, nums);
  const out = {};
  for (const r of rows || []) (out[r.user_id] = out[r.user_id] || []).push(r.class_group);
  return out;
}

module.exports = {
  classesOf, isScoped, classFilter, canSeeClass, canSeeUser, canSeeAttempt,
  assertUsers, setClasses, classesForMany,
};
