/* 找 Playwright。
 *
 * Playwright 故意不是這個專案的相依套件（正式環境不該裝瀏覽器），
 * 所以它可能在本地 devDependencies，也可能是全域 npm i -g。
 * ESM 的 import 不吃 NODE_PATH，全域安裝時 bare import 會直接失敗，
 * 這裡就依序試過去，都找不到才給一句看得懂的話。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const req = createRequire(import.meta.url);
const cands = [];
const push = (p) => { if (p && !cands.includes(p)) cands.push(p); };

if (process.env.PLAYWRIGHT_PATH) push(process.env.PLAYWRIGHT_PATH);
push('playwright');                                    // 本地 node_modules
try { push(req.resolve('playwright')); } catch { /* 沒有就算了 */ }
try {                                                  // 全域 npm root -g
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (root) push(`${root}/playwright/index.js`);
} catch { /* 沒有 npm 也沒關係 */ }
for (const p of ['/usr/lib', '/usr/local/lib', `${process.env.HOME || ''}/.npm-global/lib`, '/home/claude/.npm-global/lib']) {
  if (p) push(`${p}/node_modules/playwright/index.js`);
}

let mod = null;
for (const p of cands) {
  try { mod = await import(p); break; } catch { /* 換下一個 */ }
}
if (!mod) {
  console.error('找不到 Playwright。要跑瀏覽器測試請先裝：');
  console.error('  npm i -D playwright && npx playwright install chromium');
  console.error('（已裝在別的地方的話，用 PLAYWRIGHT_PATH 指過去）');
  console.error('找過這些位置：\n  ' + cands.join('\n  '));
  process.exit(2);
}
const pw = mod.default || mod;
export const { chromium, firefox, webkit } = pw;
export default pw;
