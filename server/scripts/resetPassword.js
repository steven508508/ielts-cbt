'use strict';
/**
 * 重設任何一個帳號的密碼（管理員被鎖在外面時的救命工具）。
 *
 *   docker compose exec app node server/scripts/resetPassword.js admin 新密碼
 *   docker compose exec app node server/scripts/resetPassword.js --list
 *
 * 手動安裝的話：  node server/scripts/resetPassword.js admin 新密碼
 */
const bcrypt = require('bcryptjs');
const db = require('../db');

(async () => {
  const [target, newPassword] = process.argv.slice(2);

  if (!target || target === '--list' || target === '-l') {
    const rows = await db.query(
      `SELECT username, name, role, class_group, active, created_at
       FROM users ORDER BY FIELD(role,'admin','teacher','student'), username`
    );
    if (!rows.length) {
      console.log('資料庫裡沒有任何帳號。可能是還沒完成初始化，試試 node server/scripts/initDb.js');
    } else {
      console.log(`共 ${rows.length} 個帳號：\n`);
      console.log('帳號'.padEnd(18), '角色'.padEnd(9), '姓名'.padEnd(16), '狀態');
      console.log('─'.repeat(60));
      for (const u of rows) {
        const role = { admin: '管理員', teacher: '老師', student: '學生' }[u.role] || u.role;
        console.log(
          String(u.username).padEnd(18),
          role.padEnd(7),
          String(u.name || '').padEnd(14),
          u.active ? '啟用' : '停用'
        );
      }
    }
    if (!target) {
      console.log('\n要改密碼：node server/scripts/resetPassword.js <帳號> <新密碼>');
    }
    process.exit(0);
  }

  if (!newPassword) {
    console.error('請一併指定新密碼：node server/scripts/resetPassword.js <帳號> <新密碼>');
    process.exit(1);
  }
  if (String(newPassword).length < 6) {
    console.error('密碼至少要 6 個字元。');
    process.exit(1);
  }

  const user = await db.one('SELECT id, username, name, role FROM users WHERE username = ?', [target]);
  if (!user) {
    console.error(`找不到帳號「${target}」。用 --list 看看有哪些帳號。`);
    process.exit(1);
  }

  await db.exec('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?', [
    await bcrypt.hash(String(newPassword), 10),
    user.id,
  ]);

  const role = { admin: '管理員', teacher: '老師', student: '學生' }[user.role] || user.role;
  console.log(`✔ 已重設 ${role}「${user.name}」（${user.username}）的密碼，帳號也一併設為啟用。`);
  console.log('  請立刻用新密碼登入，並在「我的帳號」再改一次。');
  process.exit(0);
})().catch((e) => {
  console.error('失敗：', e.message);
  process.exit(1);
});
