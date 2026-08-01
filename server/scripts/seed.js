'use strict';
/** 匯入範例試卷、建立示範班級與學生，並指派考試。 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { validatePaper } = require('../lib/paper');

const DEMO_STUDENTS = [
  ['王小明', 'student1'], ['陳美玲', 'student2'], ['林俊傑', 'student3'],
  ['張雅婷', 'student4'], ['李承翰', 'student5'],
];

(async () => {
  await db.initSchema();
  await db.bootstrapAdmin();

  const admin = await db.one("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");

  // ── 老師 ──
  let teacher = await db.one('SELECT id FROM users WHERE username = ?', ['teacher1']);
  if (!teacher) {
    const id = await db.insert(
      "INSERT INTO users (username, password_hash, name, role) VALUES (?,?,?,'teacher')",
      ['teacher1', await bcrypt.hash('teach1234', 10), '示範老師']
    );
    teacher = { id };
    console.log('建立老師帳號：teacher1 / teach1234');
  }

  // ── 學生 ──
  let n = 0;
  for (const [name, username] of DEMO_STUDENTS) {
    const dup = await db.one('SELECT id FROM users WHERE username = ?', [username]);
    if (dup) continue;
    await db.insert(
      `INSERT INTO users (username, password_hash, name, role, class_group, candidate_no)
       VALUES (?,?,?,'student',?,?)`,
      [username, await bcrypt.hash('ielts1234', 10), name, '示範班', `A${String(++n).padStart(4, '0')}`]
    );
  }
  if (n) console.log(`建立 ${n} 位示範學生（密碼皆為 ielts1234）`);

  // ── 範例試卷 ──
  const file = path.join(config.SAMPLES_DIR, 'full-paper-academic.json');
  if (!fs.existsSync(file)) {
    console.log('找不到 samples/full-paper-academic.json，略過試卷匯入。');
    process.exit(0);
  }
  const paper = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = validatePaper(paper);
  if (!result.ok) {
    console.error('範例試卷驗證失敗：', result.errors);
    process.exit(1);
  }

  let test = await db.one('SELECT id FROM tests WHERE title = ?', [paper.title]);
  if (!test) {
    const id = await db.insert(
      'INSERT INTO tests (title, test_type, description, content, published, created_by) VALUES (?,?,?,?,1,?)',
      [result.paper.title, result.paper.testType, result.paper.description || null,
       JSON.stringify(result.paper), teacher.id || admin.id]
    );
    test = { id };
    console.log(`匯入範例試卷：${paper.title}（聽力 ${result.stats.listening} 題、閱讀 ${result.stats.reading} 題）`);
  }

  const asg = await db.one('SELECT id FROM assignments WHERE test_id = ? AND class_group = ?', [test.id, '示範班']);
  if (!asg) {
    await db.insert(
      `INSERT INTO assignments (test_id, class_group, modules, speaking_grading, writing_grading, max_attempts, created_by)
       VALUES (?,?,?,?,?,?,?)`,
      [test.id, '示範班', 'listening,reading,writing,speaking', 'ai', 'ai', 3, teacher.id || admin.id]
    );
    console.log('已指派給「示範班」');
  }

  console.log('\n完成。可用帳號：');
  console.log(`  管理員　${config.bootstrapAdmin.username} / ${config.bootstrapAdmin.password}`);
  console.log('  老師　　teacher1 / teach1234');
  console.log('  學生　　student1 ~ student5 / ielts1234');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
