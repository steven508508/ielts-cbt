'use strict';
/**
 * 試卷結構定義、題型登錄表、驗證與工具函式。
 *
 * ── 試卷 JSON 結構 ────────────────────────────────────────────
 * {
 *   title, testType: 'academic'|'general', description,
 *   modules: [
 *     { module: 'listening'|'reading'|'writing'|'speaking',
 *       durationSec, transferSec,
 *       sections: [
 *         { title, instructions,
 *           audio: '/uploads/audio/x.mp3',      // 聽力
 *           passageTitle, passage,               // 閱讀（支援簡易 HTML）
 *           groups: [
 *             { type: <題型>, instructions, wordLimit, allowNumbers,
 *               image, options: [{key,text}],
 *               bodyHtml: '...[[1]]...',         // 填空題的版面，[[n]] 是空格
 *               questions: [ {number, text, answers:[…], explanation} ] }
 *           ] } ] } ] }
 */

// ── 題型登錄表 ────────────────────────────────────────────────
const QUESTION_TYPES = {
  mcq_single: {
    label: '單選題 Multiple choice (one answer)',
    modules: ['listening', 'reading'],
    objective: true,
    answerKind: 'letter',
    needsOptions: true,
    officialNames: ['Multiple choice'],
  },
  mcq_multi: {
    label: '多選題 Multiple choice (more than one answer)',
    modules: ['listening', 'reading'],
    objective: true,
    answerKind: 'letters',
    needsOptions: true,
    note: '一題佔多個題號，選對一個給一分',
    officialNames: ['Multiple choice (choose TWO/THREE letters)'],
  },
  tfng: {
    label: 'True / False / Not Given',
    modules: ['reading'],
    objective: true,
    answerKind: 'enum',
    enumValues: ['TRUE', 'FALSE', 'NOT GIVEN'],
    officialNames: ['Identifying information'],
  },
  ynng: {
    label: 'Yes / No / Not Given',
    modules: ['reading'],
    objective: true,
    answerKind: 'enum',
    enumValues: ['YES', 'NO', 'NOT GIVEN'],
    officialNames: ["Identifying writer's views/claims"],
  },
  matching: {
    label: '配對題 Matching',
    modules: ['listening', 'reading'],
    objective: true,
    answerKind: 'letter',
    needsOptions: true,
    officialNames: [
      'Matching information',
      'Matching headings',
      'Matching features',
      'Matching sentence endings',
      'Matching (Listening)',
    ],
  },
  gap_fill: {
    label: '填空題 Completion（自行輸入）',
    modules: ['listening', 'reading'],
    objective: true,
    answerKind: 'text',
    supportsBody: true,
    officialNames: [
      'Form completion', 'Note completion', 'Table completion',
      'Flow-chart completion', 'Summary completion', 'Sentence completion',
      'Diagram label completion',
    ],
  },
  gap_fill_bank: {
    label: '填空題 Completion（從選項清單挑）',
    modules: ['listening', 'reading'],
    objective: true,
    answerKind: 'letter',
    needsOptions: true,
    supportsBody: true,
    officialNames: ['Summary completion with word list'],
  },
  short_answer: {
    label: '簡答題 Short-answer questions',
    modules: ['listening', 'reading'],
    objective: true,
    answerKind: 'text',
    officialNames: ['Short-answer questions'],
  },
  label_image: {
    label: '圖表／地圖／平面圖標示 Labelling',
    modules: ['listening', 'reading'],
    objective: true,
    answerKind: 'mixed',
    needsImage: true,
    officialNames: ['Plan/map/diagram labelling'],
  },
  writing_task: {
    label: '寫作 Writing Task',
    modules: ['writing'],
    objective: false,
    officialNames: ['Task 1', 'Task 2'],
  },
  speaking_part: {
    label: '口說 Speaking Part',
    modules: ['speaking'],
    objective: false,
    officialNames: ['Part 1', 'Part 2 (cue card)', 'Part 3'],
  },
};

const MODULES = ['listening', 'reading', 'writing', 'speaking'];

const MODULE_DEFAULTS = {
  listening: { durationSec: 30 * 60, transferSec: 0 },   // 機考聽力 30 分 + 2 分檢查
  reading: { durationSec: 60 * 60, transferSec: 0 },
  writing: { durationSec: 60 * 60, transferSec: 0 },
  speaking: { durationSec: 14 * 60, transferSec: 0 },
};

// ── 工具 ──────────────────────────────────────────────────────
function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

/** 取出 bodyHtml 中的空格編號，例如 "…[[3]]…" → [3] */
function gapsIn(html) {
  if (!html) return [];
  const out = [];
  const re = /\[\[\s*(\d+)\s*\]\]/g;
  let m;
  while ((m = re.exec(html))) out.push(Number(m[1]));
  return out;
}

/** 補齊缺漏欄位、自動編題號；回傳新的物件（不改原物件） */
/** 純文字 → 段落 HTML；本來就是 HTML 就原封不動 */
function asHtml(text) {
  const s = String(text ?? '').trim();
  if (!s) return s;
  if (/<(p|div|table|ul|ol|h[1-6]|figure|img|br)\b/i.test(s)) return s;
  return s
    .split(/\n{2,}/)
    .map((para) => `<p>${para.split(/\n/).join('<br>')}</p>`)
    .join('');
}

function normalizePaper(input) {
  const paper = JSON.parse(JSON.stringify(input || {}));
  paper.title = paper.title || 'Untitled IELTS Test';
  paper.testType = paper.testType === 'general' ? 'general' : 'academic';
  paper.modules = Array.isArray(paper.modules) ? paper.modules : [];

  for (const mod of paper.modules) {
    mod.module = String(mod.module || '').toLowerCase();
    const def = MODULE_DEFAULTS[mod.module] || {};
    if (!mod.durationSec) mod.durationSec = def.durationSec || 1800;
    if (mod.transferSec == null) mod.transferSec = def.transferSec || 0;
    mod.sections = Array.isArray(mod.sections) ? mod.sections : [];

    // 客觀題自動連續編號
    let counter = 0;
    for (const [si, sec] of mod.sections.entries()) {
      sec.title = sec.title || `${mod.module === 'reading' ? 'Passage' : 'Section'} ${si + 1}`;
      sec.groups = Array.isArray(sec.groups) ? sec.groups : [];
      // 老師直接貼純文字時，把段落補成 <p>，否則整篇會擠成一坨
      if (sec.passage) sec.passage = asHtml(sec.passage);
      for (const g of sec.groups) {
        g.type = String(g.type || '').trim();
        g.questions = Array.isArray(g.questions) ? g.questions : [];
        const normOptions = (list) => {
          if (!Array.isArray(list)) return null;
          return list.map((o, i) =>
            typeof o === 'string'
              ? { key: String.fromCharCode(65 + i), text: o }
              : { key: String(o.key ?? String.fromCharCode(65 + i)), text: String(o.text ?? '') }
          );
        };
        if (g.options && !Array.isArray(g.options)) g.options = [];
        g.options = normOptions(g.options) || g.options;
        for (const q of g.questions) {
          // 每題可以有自己的選項（單選題常見）；沒有就用題組共用的。
          // 空陣列一定要拿掉：`q.options || g.options` 會把 [] 當成有值，
          // 題組層的選項就被蓋掉，學生端整題變成沒有選項可以按。
          if (q.options) q.options = normOptions(q.options);
          if (Array.isArray(q.options) && !q.options.length) delete q.options;
          // prompt 是早期的欄位名。統一成 text，
          // 否則學生端只看 q.text，整個題幹會變成一片空白。
          if (!String(q.text ?? '').trim() && String(q.prompt ?? '').trim()) q.text = q.prompt;
          if (q.prompt != null && q.prompt === q.text) delete q.prompt;
        }
        const meta = QUESTION_TYPES[g.type];
        if (meta && meta.objective) {
          for (const q of g.questions) {
            counter += 1;
            if (!q.number) q.number = counter;
            else counter = q.number;
            if (q.answers == null) q.answers = [];
            if (!Array.isArray(q.answers)) q.answers = [q.answers];
            q.answers = q.answers.map((a) => (a == null ? '' : String(a)));
            /* 選項字母型的答案，老師最自然的寫法是「A,D」。
               匯入只認 // ; ；當分隔符，於是變成 answers:['A,D'] 這一個字串。
               驗證卻是 String(a).split(/[,\s]+/) 逐字檢查 —— 兩個字母都在選項
               清單裡，所以驗證全綠。但評分是整串比對，學生選了 A 和 D 會拿到
               「選了 2 個，超過規定的 1 個」，全班 0 分，而檢討頁上「你的答案」
               與「正解」印出來一模一樣。這裡把它拆開。 */
            if (meta.answerKind === 'letter' || meta.answerKind === 'letters') {
              q.answers = q.answers
                .flatMap((a) => String(a).split(/[,、，\s]+/))
                .map((a) => a.trim())
                .filter(Boolean);
            }
          }
        }
      }
    }
  }
  return paper;
}

/** 驗證試卷結構；回傳 { ok, errors, warnings, stats } */
function validatePaper(input) {
  const errors = [];
  const warnings = [];
  const stats = { listening: 0, reading: 0, writingTasks: 0, speakingParts: 0 };

  if (!isObj(input)) return { ok: false, errors: ['試卷必須是一個 JSON 物件'], warnings, stats };
  const paper = normalizePaper(input);
  if (!paper.title) errors.push('缺少 title');
  if (!paper.modules.length) errors.push('modules 是空的，至少要有一科');

  for (const mod of paper.modules) {
    const where = `[${mod.module || '?'}]`;
    if (!MODULES.includes(mod.module)) {
      errors.push(`${where} module 必須是 listening / reading / writing / speaking 其中之一`);
      continue;
    }
    if (!mod.sections.length) warnings.push(`${where} 沒有任何 section`);

    const seen = new Set();
    for (const sec of mod.sections) {
      if (mod.module === 'listening' && !sec.audio) warnings.push(`${where} ${sec.title} 沒有指定 audio 音檔`);
      if (mod.module === 'reading' && !sec.passage) warnings.push(`${where} ${sec.title} 沒有 passage 文章內容`);

      for (const g of sec.groups) {
        const meta = QUESTION_TYPES[g.type];
        if (!meta) {
          errors.push(`${where} ${sec.title}：未知題型 "${g.type}"（可用：${Object.keys(QUESTION_TYPES).join(', ')}）`);
          continue;
        }
        if (!meta.modules.includes(mod.module))
          errors.push(`${where} 題型 ${g.type} 不能用在 ${mod.module}`);
        const everyQHasOptions = g.questions.length > 0 && g.questions.every((q) => q.options?.length >= 2);
        if (meta.needsOptions && (!g.options || g.options.length < 2) && !everyQHasOptions)
          errors.push(`${where} ${sec.title}：題型 ${g.type} 需要 options 選項清單（可放在題組層或每一題）`);
        if (meta.needsImage && !g.image)
          warnings.push(`${where} ${sec.title}：${g.type} 建議提供 image 圖片`);

        /* 多選題的題號數、selectCount、正解個數三者必須一致。
           以前完全沒有檢查：selectCount 沒填時前端會退回 1，指示語寫著
           「Choose TWO letters」，學生選第二個卻跳出「最多只能選 1 個」——
           錯誤訊息看起來像在怪學生，而這一題必然 0 分。
           selectCount 比題號數少的話，多出來的題號也永遠拿不到分。 */
        if (g.type === 'mcq_multi' && g.questions.length) {
          const slots = g.questions.length;
          const keys = [...new Set(g.questions.flatMap((q) => q.answers || []).map((a) => String(a).toUpperCase()))];
          const pick = Number(g.selectCount || 0);
          if (!pick) {
            errors.push(`${where} ${sec.title}：多選題必須指定 selectCount（要選幾個），`
              + `否則學生只能選 1 個，但指示語會寫要選 ${slots} 個`);
          } else if (pick !== slots) {
            errors.push(`${where} ${sec.title}：多選題佔 ${slots} 個題號，selectCount 卻是 ${pick} —— `
              + `兩者必須一致，否則多出來的題號永遠拿不到分`);
          }
          if (keys.length && pick && keys.length !== pick) {
            errors.push(`${where} ${sec.title}：多選題要選 ${pick} 個，`
              + `但正解只有 ${keys.length} 個（${keys.join('、')}）`);
          }
        }

        if (meta.supportsBody && g.bodyHtml) {
          const gaps = gapsIn(g.bodyHtml);
          const nums = g.questions.map((q) => q.number);
          const missing = nums.filter((n) => !gaps.includes(n));
          const extra = gaps.filter((n) => !nums.includes(n));
          if (missing.length) errors.push(`${where} ${sec.title}：bodyHtml 缺少空格 [[${missing.join(']] [[')}]]`);
          if (extra.length) errors.push(`${where} ${sec.title}：bodyHtml 有多餘的空格 [[${extra.join(']] [[')}]]`);
        }

        if (meta.objective) {
          // 有 bodyHtml 時，空格本身就是題目；否則每一題都要有看得到的題幹
          const bodyGaps = meta.supportsBody && g.bodyHtml ? gapsIn(g.bodyHtml) : [];
          // 多選題整組共用第一題的題幹
          const sharedStem = g.type === 'mcq_multi' && g.questions.some((q) => String(q.text || '').trim());
          for (const q of g.questions) {
            if (seen.has(q.number)) errors.push(`${where} 題號 ${q.number} 重複`);
            seen.add(q.number);
            if (!String(q.text || '').trim() && !bodyGaps.includes(q.number) && !sharedStem)
              errors.push(`${where} 第 ${q.number} 題學生看不到題目：請填 text 題幹，或在 bodyHtml 裡放 [[${q.number}]] 空格`);
            if (!q.answers || !q.answers.length || q.answers.every((a) => !String(a).trim()))
              errors.push(`${where} 第 ${q.number} 題沒有標準答案`);
            if (meta.answerKind === 'enum') {
              for (const a of q.answers) {
                if (!meta.enumValues.includes(String(a).trim().toUpperCase()))
                  errors.push(`${where} 第 ${q.number} 題答案必須是 ${meta.enumValues.join(' / ')}，目前是 "${a}"`);
              }
            }
            const optList = q.options?.length ? q.options : g.options;
            if (meta.needsOptions && optList?.length) {
              const keys = optList.map((o) => o.key.toUpperCase());
              for (const a of q.answers) {
                for (const letter of String(a).split(/[,\s]+/).filter(Boolean)) {
                  if (!keys.includes(letter.toUpperCase()))
                    errors.push(`${where} 第 ${q.number} 題答案 "${letter}" 不在選項清單 ${keys.join('/')} 內`);
                }
              }
            }
            if (mod.module === 'listening') stats.listening += 1;
            if (mod.module === 'reading') stats.reading += 1;
          }
        } else if (g.type === 'writing_task') {
          stats.writingTasks += g.questions.length || 1;
        } else if (g.type === 'speaking_part') {
          stats.speakingParts += 1;
        }
      }
    }
  }

  if (stats.listening && stats.listening !== 40)
    warnings.push(`聽力共 ${stats.listening} 題（官方為 40 題），分數換算會依實際題數等比對照`);
  if (stats.reading && stats.reading !== 40)
    warnings.push(`閱讀共 ${stats.reading} 題（官方為 40 題），分數換算會依實際題數等比對照`);

  return { ok: errors.length === 0, errors, warnings, stats, paper };
}

/** 把某一科的所有客觀題攤平成一維陣列，方便批改與導覽 */
/**
 * 每一節的素材（文章、逐字稿、音檔）。
 *
 * 刻意跟 flattenQuestions 分開：一篇閱讀文章一千字，
 * 複製到那一節的十三題上就是十三份，光一次檢討就多傳幾百 KB。
 */
function sectionMedia(paper, moduleName) {
  const mod = (paper.modules || []).find((m) => m.module === moduleName);
  if (!mod) return [];
  return (mod.sections || []).map((sec, i) => ({
    index: i,
    title: sec.title || '',
    passageTitle: sec.passageTitle || null,
    passage: sec.passage || null,
    transcript: sec.transcript || null,
    audio: sec.audio || null,
    // 素材編輯器有「本節圖片（地圖／平面圖）」這個欄位，
    // 但以前沒有任何地方讀它，老師填了等於丟進黑洞
    image: sec.image || null,
  }));
}

function flattenQuestions(paper, moduleName) {
  const out = [];
  const mod = (paper.modules || []).find((m) => m.module === moduleName);
  if (!mod) return out;
  for (const [si, sec] of mod.sections.entries()) {
    for (const [gi, g] of sec.groups.entries()) {
      const meta = QUESTION_TYPES[g.type];
      if (!meta || !meta.objective) continue;
      for (const q of g.questions) {
        out.push({
          number: q.number,
          type: g.type,
          sectionIndex: si,
          groupIndex: gi,
          sectionTitle: sec.title,
          text: q.text || '',
          answers: q.answers || [],
          explanation: q.explanation || '',
          wordLimit: g.wordLimit ?? null,
          allowNumbers: g.allowNumbers !== false,
          options: q.options || g.options || null,
          // 配合題／選字填空的選項是整個題組共用的（十三題共用一份 A–H）。
          // 檢討時要畫在題組上方一次，而不是每一題底下重複十三遍。
          optionsShared: !q.options && !!g.options,
          groupType: g.type,
          multiCount: g.type === 'mcq_multi' ? (g.selectCount || (q.answers || []).length) : null,
          // 檢討錯題時沒有這些就只剩一句題幹，學生根本看不懂當初在問什麼。
          // 文章／逐字稿留在 sectionMedia()，這裡只帶「跟著題目走」的東西。
          instructions: g.instructions || '',
          image: q.image || g.image || null,
          bodyHtml: g.bodyHtml || null,
        });
      }
    }
  }
  out.sort((a, b) => a.number - b.number);
  return out;
}

/** 移除所有答案與解析，產出可以安全送給學生的版本 */
function stripAnswers(paper) {
  const p = JSON.parse(JSON.stringify(paper));
  for (const mod of p.modules || []) {
    for (const sec of mod.sections || []) {
      for (const g of sec.groups || []) {
        for (const q of g.questions || []) {
          delete q.answers;
          delete q.explanation;
          delete q.acceptAlternatives;
          delete q.sampleAnswer;
        }
        delete g.answerKeyNote;
      }
    }
  }
  return p;
}

/** 全卷題數統計 */
function countQuestions(paper, moduleName) {
  return flattenQuestions(paper, moduleName).length;
}

module.exports = {
  sectionMedia,
  QUESTION_TYPES, MODULES, MODULE_DEFAULTS,
  normalizePaper, validatePaper, flattenQuestions, stripAnswers, countQuestions, gapsIn,
};
