'use strict';
/**
 * 從伺服器命令列控制 Cloudflare Turnstile 人機驗證。
 *
 * 這是「驗證框壞掉時的救命工具」——如果登入頁的驗證框載入不出來，
 * 沒有人（包含管理員）進得了後台把它關掉，只能從伺服器這邊關。
 *
 *   docker compose exec app node server/scripts/turnstile.js --status
 *   docker compose exec app node server/scripts/turnstile.js --off
 *   docker compose exec app node server/scripts/turnstile.js --on
 *   docker compose exec app node server/scripts/turnstile.js --site-key=0x4AAA... --secret-key=0x4AAA...
 *   docker compose exec app node server/scripts/turnstile.js --test
 *
 * 手動安裝的話把 `docker compose exec app` 拿掉即可。
 * 另外也可以在 .env 加 TURNSTILE_DISABLED=1 再重啟，效果一樣（且不需要動資料庫）。
 */
const db = require('../db');
const turnstile = require('../lib/turnstile');

function parseArgs(argv) {
  const out = { flags: new Set(), opts: {} };
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out.opts[m[1]] = m[2];
    else if (a.startsWith('--')) out.flags.add(a.slice(2));
    else out.flags.add(a.replace(/^-/, ''));
  }
  return out;
}

function show(c) {
  const m = turnstile.maskConfig(c);
  console.log('');
  console.log('  Cloudflare Turnstile 目前設定');
  console.log('  ' + '─'.repeat(46));
  console.log('  啟用開關      ', m.enabled ? '開' : '關');
  console.log('  Site Key      ', m.siteKey || '（未設定）');
  console.log('  Secret Key    ', m.secretKey || '（未設定）');
  console.log('  連不上時放行  ', m.failOpen ? '是（建議）' : '否');
  console.log('  實際生效      ', m.active ? '★ 是，登入需要通過人機驗證' : '否，登入不會檢查');
  if (process.env.TURNSTILE_DISABLED === '1') {
    console.log('');
    console.log('  ⚠ 環境變數 TURNSTILE_DISABLED=1 已強制關閉人機驗證，');
    console.log('    不論上面的開關是什麼都不會生效。');
  }
  console.log('');
}

const HELP = `
用法：node server/scripts/turnstile.js [選項]

  --status              顯示目前設定（預設）
  --off, --disable      關閉人機驗證（登入頁不再顯示驗證框）
  --on, --enable        開啟人機驗證（需要已設定兩把金鑰）
  --site-key=<KEY>      設定 Site Key（公開，會出現在網頁原始碼）
  --secret-key=<KEY>    設定 Secret Key（機密，只留在伺服器）
  --fail-open           Cloudflare 連不上時放行（預設，建議）
  --no-fail-open        Cloudflare 連不上時擋住登入
  --clear               清空兩把金鑰並關閉
  --test                用目前的 Secret Key 實際打一次 Cloudflare 確認有效
  --help                顯示這段說明

例：驗證框載入不出來、大家都登不進去時
  node server/scripts/turnstile.js --off
`;

(async () => {
  const { flags, opts } = parseArgs(process.argv.slice(2));

  if (flags.has('help') || flags.has('h')) {
    console.log(HELP);
    process.exit(0);
  }

  const patch = {};
  if (flags.has('off') || flags.has('disable')) patch.enabled = false;
  if (flags.has('on') || flags.has('enable')) patch.enabled = true;
  if (flags.has('fail-open')) patch.failOpen = true;
  if (flags.has('no-fail-open')) patch.failOpen = false;
  if (opts['site-key'] !== undefined) patch.siteKey = opts['site-key'].trim();
  if (opts['secret-key'] !== undefined) patch.secretKey = opts['secret-key'].trim();
  if (flags.has('clear')) { patch.siteKey = ''; patch.secretKey = ''; patch.enabled = false; }

  if (Object.keys(patch).length) {
    if (patch.enabled === true) {
      const cur = await turnstile.getConfig(true);
      const site = patch.siteKey ?? cur.siteKey;
      const secret = patch.secretKey ?? cur.secretKey;
      if (!site || !secret) {
        console.error('無法開啟：Site Key 與 Secret Key 都要先設定好。');
        console.error('  node server/scripts/turnstile.js --site-key=... --secret-key=... --on');
        process.exit(1);
      }
    }
    const next = await turnstile.saveConfig(patch);
    console.log('✔ 設定已更新（伺服器最多 15 秒後生效，不必重啟）。');
    show(next);
    if (patch.enabled === false) {
      console.log('  等 15 秒後重新整理登入頁，就不會再出現人機驗證框，');
      console.log('  可以直接用帳號密碼登入。');
      console.log('  修好 Cloudflare 那邊的設定後，再到「系統設定 → 人機驗證」開回來。');
      console.log('');
    }
  } else if (flags.has('test')) {
    const c = await turnstile.getConfig(true);
    if (!c.secretKey) { console.error('尚未設定 Secret Key，無法測試。'); process.exit(1); }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(turnstile.VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: c.secretKey, response: 'connectivity-test-token' }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      const data = await r.json();
      const codes = data['error-codes'] || [];
      if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
        console.error('✘ Secret Key 無效，Cloudflare 不認得這把金鑰。', codes.join(', '));
        process.exit(1);
      }
      console.log('✔ 伺服器連得到 Cloudflare，Secret Key 看起來有效。');
      console.log('  （注意：這只驗證伺服器端。學生瀏覽器連不連得到 challenges.cloudflare.com 是另一回事。）');
    } catch (e) {
      console.error(`✘ 伺服器無法連線到 Cloudflare：${e.message}`);
      console.error('  如果 failOpen 是「是」，登入仍會放行；否則所有人都會登不進來。');
      process.exit(1);
    }
  } else {
    show(await turnstile.getConfig(true));
    console.log(HELP);
  }

  await db.close().catch(() => {});
  process.exit(0);
})().catch(async (e) => {
  console.error('失敗：', e.message);
  await db.close().catch(() => {});
  process.exit(1);
});
