'use strict';
const db = require('../db');
const config = require('../config');

(async () => {
  await db.initSchema();
  const created = await db.bootstrapAdmin();
  console.log('資料表建立完成。');
  if (created) console.log(`管理員帳號：${created} / 密碼：${config.bootstrapAdmin.password}`);
  else console.log('已存在管理員帳號，未重複建立。');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
