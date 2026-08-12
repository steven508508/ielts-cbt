#!/usr/bin/env node
/* 合成示範站的音檔：聽力四節 + 口說考官的每一句。
 *
 * 需要 piper（pip install piper-tts）與 ffmpeg。聲線第一次會自動下載。
 * 產物放在 demo/audio/，build-demo.mjs 會複製到 docs/。
 *
 *   node scripts/build-demo-audio.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'demo', 'audio');
const VOICES = process.env.PIPER_VOICES || path.join(os.tmpdir(), 'piper-voices');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-audio-'));

const NEEDED = [
  'en_GB-alba-medium', 'en_GB-northern_english_male-medium',
  'en_GB-jenny_dioco-medium', 'en_US-ryan-high',
];
const VOICE = {
  TOM: 'en_GB-northern_english_male-medium',
  RACHEL: 'en_GB-alba-medium',
  FIONA: 'en_GB-jenny_dioco-medium',
  'DR FINCH': 'en_US-ryan-high',
  NADIA: 'en_GB-alba-medium',
  CALLUM: 'en_GB-northern_english_male-medium',
  LECTURER: 'en_US-ryan-high',
  NARRATOR: 'en_GB-jenny_dioco-medium',
};
const FALLBACK = 'en_GB-alba-medium';
const model = (name) => path.join(VOICES, `${VOICE[name] || FALLBACK}.onnx`);

for (const bin of ['piper', 'ffmpeg']) {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); }
  catch { console.error(`找不到 ${bin}。piper：pip install piper-tts　ffmpeg：apt install ffmpeg`); process.exit(1); }
}
fs.mkdirSync(VOICES, { recursive: true });
const missing = NEEDED.filter((v) => !fs.existsSync(path.join(VOICES, `${v}.onnx`)));
if (missing.length) {
  console.log(`下載聲線 ${missing.join(', ')}…`);
  execFileSync('python3', ['-m', 'piper.download_voices', ...missing, '--data-dir', VOICES], { stdio: 'inherit' });
}

const say = (text, voiceName, wav) => {
  execFileSync('piper', ['--model', model(voiceName), '--output-file', wav],
    { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 180000 });
};
const silence = (sec, wav) => execFileSync('ffmpeg',
  ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', String(sec), '-c:a', 'pcm_s16le', wav],
  { stdio: 'ignore' });
const joinToMp3 = (parts, mp3, bitrate = '48k') => {
  const list = path.join(WORK, 'list-' + Math.random().toString(36).slice(2) + '.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  fs.mkdirSync(path.dirname(mp3), { recursive: true });
  // loudnorm：各節聽起來一樣大聲，並留 1.5 dB 餘裕不削峰
  execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11',
    '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', bitrate, mp3], { stdio: 'ignore' });
};
const dur = (f) => Number(execFileSync('ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]).toString().trim());
const kb = (f) => Math.round(fs.statSync(f).size / 1024);

// 獨白整段丟給 TTS 會一口氣唸完、沒有換氣，聽起來完全不像人。切句。
function split(text, max = 260) {
  if (text.length <= max) return [text];
  const out = []; let buf = '';
  for (const s of text.match(/[^.!?]+[.!?]*\s*/g) || [text]) {
    if ((buf + s).length > max && buf) { out.push(buf.trim()); buf = s; } else buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
function parseTranscript(t) {
  const turns = [];
  for (const raw of String(t).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Z][A-Z .'-]{1,24}):\s*(.*)$/);
    if (m) turns.push({ speaker: m[1].trim(), text: m[2].trim() });
    else if (turns.length) turns[turns.length - 1].text += ' ' + line;
    else turns.push({ speaker: 'NARRATOR', text: line });
  }
  return turns.filter((x) => x.text);
}

// ── 聽力 ─────────────────────────────────────────────────────────────
const paper = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'full-paper-academic.json'), 'utf8'));
const L = paper.modules.find((m) => m.module === 'listening');
let n = 0;
for (const sec of L.sections) {
  n++;
  const turns = parseTranscript(sec.transcript || '');
  if (!turns.length) { console.log(`Section ${n}：沒有逐字稿，跳過`); continue; }
  const intro = { speaker: 'NARRATOR', text: `Section ${n}. You will now hear section ${n}.` };
  const all = [intro, ...turns];

  const units = [];
  all.forEach((t, j) => split(t.text).forEach((c, k, arr) => units.push({
    speaker: t.speaker, text: c, lastOfTurn: k === arr.length - 1,
    nextSpeaker: all[j + 1]?.speaker, isIntro: j === 0,
  })));

  console.log(`Section ${n}：${turns.length} 輪 → ${units.length} 個單位`);
  const parts = [];
  units.forEach((u, j) => {
    const wav = path.join(WORK, `s${n}-${String(j).padStart(3, '0')}.wav`);
    try { say(u.text, u.speaker, wav); parts.push(wav); }
    catch { console.log(`   ! 跳過：${u.text.slice(0, 40)}…`); return; }
    const gap = u.isIntro ? 1.6 : !u.lastOfTurn ? 0.28
      : (u.nextSpeaker && u.nextSpeaker !== u.speaker ? 0.5 : 0.3);
    const sil = wav.replace('.wav', '-gap.wav');
    silence(gap, sil); parts.push(sil);
  });
  const mp3 = path.join(OUT, `section${n}.mp3`);
  joinToMp3(parts, mp3);
  console.log(`  → ${path.relative(ROOT, mp3)}　${Math.floor(dur(mp3) / 60)} 分 ${Math.round(dur(mp3) % 60)} 秒，${kb(mp3)} KB`);
}

// ── 口說考官 ─────────────────────────────────────────────────────────
const spk = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo', 'speaking-script.json'), 'utf8'));
const exVoice = spk.examinerVoice || 'en_GB-jenny_dioco-medium';
if (!fs.existsSync(path.join(VOICES, `${exVoice}.onnx`))) {
  execFileSync('python3', ['-m', 'piper.download_voices', exVoice, '--data-dir', VOICES], { stdio: 'inherit' });
}
console.log(`\n口說考官（${exVoice}）：`);
let count = 0;
spk.turns.forEach((t, i) => {
  if (!t.ex) return;
  const parts = [];
  split(t.ex, 300).forEach((c, k) => {
    const wav = path.join(WORK, `ex-${i}-${k}.wav`);
    execFileSync('piper', ['--model', path.join(VOICES, `${exVoice}.onnx`), '--output-file', wav],
      { input: c, stdio: ['pipe', 'ignore', 'ignore'], timeout: 180000 });
    parts.push(wav);
    const sil = wav.replace('.wav', '-gap.wav');
    silence(0.3, sil); parts.push(sil);
  });
  const mp3 = path.join(OUT, 'speaking', `ex-${String(i).padStart(2, '0')}.mp3`);
  joinToMp3(parts, mp3, '56k');
  count++;
  console.log(`  ex-${String(i).padStart(2, '0')}.mp3　${dur(mp3).toFixed(1)} 秒，${kb(mp3)} KB`);
});
console.log(`\n考官語音 ${count} 段`);

fs.rmSync(WORK, { recursive: true, force: true });
console.log('完成 → demo/audio/');
