#!/usr/bin/env node
/* 組出 GitHub Pages 用的靜態示範站到 _site/。
 *
 * _site/ 不進版控 —— 它整份都是從 public/ 複製來的，提交等於把前端存兩份，
 * 而且一定會有人改了 public/ 忘記重建，示範站就開始跟真站不一樣。
 * 由 .github/workflows/pages.yml 每次 push 自動建置並部署。
 *
 *   node scripts/build-demo.mjs            # 用現有的音檔（沒有就跳過）
 *   node scripts/build-demo.mjs --audio    # 連聽力與考官語音一起重新合成（需要 piper + ffmpeg）
 *
 * 前端程式碼是從 public/ 原封不動複製過去的 —— 示範站跑的就是真的 UI，
 * 只有後端被 demo/shim.js 換成瀏覽器裡的假後端。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, '_site');   // 建置產物，不進版控；由 GitHub Actions 部署到 Pages
const OUT = (...p) => path.join(DOCS, ...p);
const SRC = (...p) => path.join(ROOT, ...p);
const WITH_AUDIO = process.argv.includes('--audio');

const log = (s) => console.log(s);
const read = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// ── 1. 前端原封不動複製 ───────────────────────────────────────────────
log('複製前端…');
for (const dir of ['css', 'js']) {
  fs.rmSync(OUT(dir), { recursive: true, force: true });
  fs.cpSync(SRC('public', dir), OUT(dir), { recursive: true });
}
const jsCount = fs.readdirSync(OUT('js')).length;
log(`  ${jsCount} 個 js、${fs.readdirSync(OUT('css')).length} 個 css`);

// ── 2. index.html：絕對路徑改相對，插入示範站的腳本 ────────────────────
log('產生 index.html…');
let html = read(SRC('public', 'index.html'));
// GitHub Pages 在 /<repo>/ 子路徑底下，"/css/x.css" 會指到網域根目錄，全部破掉
html = html.replace(/(href|src)="\/([^"]+)"/g, '$1="$2"');
html = html.replace('<title>IELTS 模擬考試系統</title>',
  '<title>IELTS CBT — 線上示範站</title>\n' +
  '<meta name="description" content="Self-hosted IELTS computer-delivered test platform — live demo. Reading, Listening, Writing and a scripted AI speaking examiner, all running in your browser.">');
// 假後端必須排在 api.js 之前：api.js 在 IIFE 裡就會讀 localStorage
html = html.replace('<script src="js/api.js"></script>',
  [
    '<script src="demo/lib.js"></script>',
    '<script src="demo/data.js"></script>',
    '<script src="demo/speaking-script.js"></script>',
    '<script src="demo/shim.js"></script>',
    '<script src="demo/speaking-ws.js"></script>',
    '<script src="js/api.js"></script>',
  ].join('\n'));
html = html.replace('</body>', '<script src="demo/banner.js"></script>\n</body>');
write(OUT('index.html'), html);

// ── 3. 把真的批改邏輯搬進瀏覽器 ────────────────────────────────────────
// 重寫一份 marking 邏輯是自找麻煩，而且示範站算出來的分數會跟真站不一樣。
log('搬移批改邏輯（answers.js / bands.js）…');
function toBrowser(file) {
  const code = read(SRC('server', 'lib', file));
  if (/require\(/.test(code)) throw new Error(`${file} 有 require()，不能直接搬到瀏覽器`);
  return `/* 從 server/lib/${file} 原封不動搬過來，只包了一層讓它能在瀏覽器跑 */\n` +
    `(function(){ const module = { exports: {} }; const exports = module.exports;\n${code}\n` +
    `window.DEMO_LIB = window.DEMO_LIB || {}; window.DEMO_LIB['${file.replace('.js', '')}'] = module.exports; })();\n`;
}
write(OUT('demo', 'lib.js'), toBrowser('answers.js') + '\n' + toBrowser('bands.js'));

// ── 4. 資料 ──────────────────────────────────────────────────────────
log('組資料…');
const paperFull = readJson(SRC('samples', 'full-paper-academic.json'));
const fixtures = SRC('demo', 'fixtures');
const exam = readJson(path.join(fixtures, 'exam.json'));
const available = readJson(path.join(fixtures, 'available.json')).available[0];
const checkConfig = readJson(path.join(fixtures, 'check-config.json'));
const resultShell = readJson(path.join(fixtures, 'result-shell.json'));

// 真站的素材放在 /uploads/ 底下。GitHub Pages 在 /<repo>/ 子路徑，絕對路徑
// 會指到網域根目錄變成 404 —— 圖片 404 在畫面上只是一塊空白，很難察覺，
// 所以這裡一起改成相對路徑。
const fixPaths = (o) => JSON.parse(JSON.stringify(o)
  .replace(/\/uploads\/audio\//g, 'demo/audio/')
  .replace(/\/uploads\/image\//g, 'demo/images/'));
const fixAudio = fixPaths;

const data = {
  user: { id: 3, username: 'demo', name: '示範考生', role: 'student',
          email: null, classGroup: '示範班', candidateNo: 'A0001' },
  available: fixAudio(available),
  exam: fixAudio(exam),
  paperFull: fixAudio(paperFull),
  checkConfig,
  resultShell,
  writingFeedback: readJson(SRC('demo', 'writing-feedback.json')),
  speaking: (() => {
    const s = readJson(SRC('demo', 'speaking-script.json'));
    return {
      scored: true,
      criteria: s.final.criteria,
      result: {
        partNo: null, band: s.final.band, criteria: s.final.criteria,
        feedback: s.final.feedback, summary: s.final.summary,
        transcript: s.turns.filter((t) => t.ex || t.ca)
          .map((t) => ({ role: t.ex ? 'examiner' : 'candidate', text: t.ex || t.ca })),
        gradedBy: 'ai', recording: null,
      },
    };
  })(),
};
write(OUT('demo', 'data.js'), 'window.DEMO_DATA = ' + JSON.stringify(data) + ';\n');
log(`  data.js ${Math.round(fs.statSync(OUT('demo', 'data.js')).size / 1024)} KB`);

const spk = readJson(SRC('demo', 'speaking-script.json'));
write(OUT('demo', 'speaking-script.js'), 'window.DEMO_SPEAKING = ' + JSON.stringify(spk) + ';\n');

for (const f of ['shim.js', 'speaking-ws.js', 'banner.js']) {
  fs.copyFileSync(SRC('demo', f), OUT('demo', f));
}

// ── 5. 音檔 ──────────────────────────────────────────────────────────
if (WITH_AUDIO) {
  log('合成音檔（會花幾分鐘）…');
  execFileSync(process.execPath, [SRC('scripts', 'build-demo-audio.mjs')], { stdio: 'inherit' });
}
const imgSrc = SRC('demo', 'images');
if (fs.existsSync(imgSrc)) {
  fs.rmSync(OUT('demo', 'images'), { recursive: true, force: true });
  fs.cpSync(imgSrc, OUT('demo', 'images'), { recursive: true });
  log(`  ${fs.readdirSync(OUT('demo', 'images')).length} 張圖`);
} else {
  log('  ! demo/images/ 不存在 —— 寫作圖表與聽力地圖會是空白。跑 python3 scripts/build-demo-images.py');
}

const audioSrc = SRC('demo', 'audio');
if (fs.existsSync(audioSrc)) {
  fs.rmSync(OUT('demo', 'audio'), { recursive: true, force: true });
  fs.cpSync(audioSrc, OUT('demo', 'audio'), { recursive: true });
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(OUT('demo', 'audio'));
  const mb = files.reduce((a, f) => a + fs.statSync(f).size, 0) / 1024 / 1024;
  log(`  ${files.length} 個音檔，共 ${mb.toFixed(1)} MB`);
} else {
  log('  ! demo/audio/ 不存在 —— 聽力與口說會沒有聲音。加 --audio 重新合成。');
}

// ── 6. GitHub Pages 的雜項 ───────────────────────────────────────────
// 沒有 .nojekyll 的話，Jekyll 會吃掉底線開頭的檔案，而且 build 會慢
write(OUT('.nojekyll'), '');

log('\n完成 → _site/');
log('本機預覽：cd _site && python3 -m http.server 8899');
