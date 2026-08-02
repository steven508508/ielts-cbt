'use strict';
/**
 * 所有「用 AI 做事」的提示詞與流程都集中在這裡：
 *   1. 產生題目（各種官方題型）
 *   2. 把貼上的原始題目文字解析成系統格式
 *   3. 寫作批改（四大標準給分 + 逐句建議 + 範文）
 *   4. 口說評分（四大標準給分 + 建議）
 *   5. 口說追問（讓 Part 1/3 更像真人考官）
 */
const ai = require('./ai');
const { QUESTION_TYPES } = require('./paper');
const diffLib = require('./difficulty');

const MODULE_ZH = { listening: '聽力', reading: '閱讀', writing: '寫作', speaking: '口說' };

// ── 共用：把系統的題型規格說明給 AI 聽 ─────────────────────────
const SCHEMA_SPEC = `
You output a "group" object for an IELTS test paper. Schema:

{
  "type": one of ${Object.keys(QUESTION_TYPES).filter(k => QUESTION_TYPES[k].objective).map(k => `"${k}"`).join(' | ')},
  "instructions": string  // exact IELTS-style rubric, e.g. "Choose TWO letters, A-E." or
                          // "Complete the notes below. Write NO MORE THAN TWO WORDS AND/OR A NUMBER for each answer."
  "wordLimit": number|null,       // for gap_fill / short_answer / label_image
  "allowNumbers": boolean,
  "options": [{"key":"A","text":"..."}],   // required for mcq_single, mcq_multi, matching, gap_fill_bank
  "selectCount": number,                    // for mcq_multi only: how many letters to choose
  "bodyHtml": "…[[1]]… [[2]]…",             // for gap_fill / gap_fill_bank: the notes/table/summary layout.
                                            // Use [[n]] where n is the question number. Simple HTML allowed
                                            // (<p> <br> <ul> <li> <table> <tr> <td> <strong> <em> <h4>).
  "questions": [
    { "number": 1, "text": "question stem (omit for pure gap_fill inside bodyHtml)",
      "options": [{"key":"A","text":"..."}],   // per-QUESTION options — use this for mcq_single,
                                               // where every question has its own set of choices
      "answers": ["correct answer", "acceptable alternative"],
      "explanation": "why this is the answer, quoting the passage/audio" }
  ]
}

Type rules:
- mcq_single   : each question carries its OWN "options" array (A-D or A-C) and exactly one letter answer.
                 Several mcq_single questions can live in one group as long as each has its own options.
- mcq_multi    : ONE stem, options A-E/A-G, selectCount = 2 or 3. Occupies selectCount question numbers
                 (e.g. numbers 21 and 22), answers = the full set of correct letters on the FIRST question object,
                 and the remaining question objects share the same answers array.
- tfng         : answers must be exactly "TRUE" | "FALSE" | "NOT GIVEN".
- ynng         : answers must be exactly "YES" | "NO" | "NOT GIVEN".
- matching     : options = the list (headings i/ii/iii…, paragraph letters, feature names, sentence endings).
                 Each question answers = one option key.
- gap_fill     : learner types the word(s). bodyHtml holds the layout. Respect wordLimit strictly —
                 every answer MUST be within the limit and MUST appear verbatim in the passage/transcript.
- gap_fill_bank: same but learner picks a letter from options.
- short_answer : standalone questions with a wordLimit.
- label_image  : questions refer to labels on a supplied plan/map/diagram image.
`.trim();

// ── 1. 產生題目 ────────────────────────────────────────────────
async function generateQuestions(opts, userId) {
  const {
    module: mod, type, topic, difficulty = 'band 6-7', count = 6,
    testType = 'academic', passage = '', transcript = '', extra = '',
    withPassage = false, sectionNo = 1, startNumber = 1,
  } = opts;

  const wants = [];
  if (withPassage && mod === 'reading') {
    wants.push(`Also write the reading passage itself (${testType === 'academic' ? '700-900 words, academic register' : '400-600 words, everyday/workplace register'}). Return it as "passage" (simple HTML with <p> and, if it is a Matching-Headings task, paragraph markers like <p><strong>A</strong> …</p>).`);
  }
  if (withPassage && mod === 'listening') {
    wants.push('Also write the full audio transcript as "transcript" (natural spoken English, with speaker labels, hesitations and self-corrections typical of the real test), plus "audioScript" giving stage directions for recording.');
  }

  const system = `You are a senior IELTS item writer for Cambridge English. You produce test material that is
indistinguishable from the official ${testType === 'general' ? 'General Training' : 'Academic'} papers:
authentic register, plausible distractors, answers that are unambiguous and verifiable in the source text,
and rubrics copied exactly from the official style.

${SCHEMA_SPEC}

Return JSON: { "group": {…}${withPassage ? ', "passage": "…", "passageTitle": "…", "transcript": "…"' : ''} }`;

  const user = `Module: ${mod}
Question type: ${type}
Topic: ${topic || '(you choose an authentic IELTS topic)'}
${diffLib.promptFor(mod, diffLib.resolve({ level: difficulty }), { testType })}
Number of question numbers to produce: ${count}
Question numbering starts at: ${startNumber}
Section: ${sectionNo}
${passage ? `\nBase the questions STRICTLY on this passage:\n"""\n${passage}\n"""` : ''}
${transcript ? `\nBase the questions STRICTLY on this listening transcript:\n"""\n${transcript}\n"""` : ''}
${extra ? `\nExtra requirements: ${extra}` : ''}
${wants.join('\n')}

Every answer must be findable in the source text. Do not create trick items.`;

  const out = await ai.chat({ system, user, json: true, maxTokens: 12000, temperature: 0.8, purpose: 'generate', userId });

  // 老師自己貼了文章／逐字稿時，AI 只會回題目，不會把原文再吐一次
  // （吐回來只是浪費 token）。但存成試卷時一定要帶著它，否則學生端
  // 就只剩題目、沒有文章可讀。這裡補回去。
  if (!out.passage && passage) out.passage = passage;
  if (!out.transcript && transcript) out.transcript = transcript;
  return out;
}

/* ── 產生一整份試卷 ────────────────────────────────────────────
   以前是「一個請求要 AI 吐出整份試卷」，輸出量三萬 token 起跳，
   幾乎必定撞上逾時（不論是本系統的 180 秒、反向代理，還是 Cloudflare
   橘雲對來源回應的 100 秒硬上限）。
   現在拆成九段分別產生，每段都在安全範圍內，也能個別重試。 */

const LISTENING_PLAN = [
  { no: 1, range: [1, 10],  brief: 'a transactional conversation between two speakers in an everyday social context (enquiry, booking, registration). Include a form/notes gap-fill.' },
  { no: 2, range: [11, 20], brief: 'a monologue in an everyday social context (a talk about a facility, a tour, local arrangements). Include a map/plan labelling or matching task.' },
  { no: 3, range: [21, 30], brief: 'a conversation between up to four people in an educational or training context (students discussing an assignment with a tutor). Include multiple choice and matching.' },
  { no: 4, range: [31, 40], brief: 'an academic lecture monologue. Include note completion / summary completion.' },
];

const READING_ACADEMIC_PLAN = [
  { no: 1, range: [1, 13],  brief: 'a factual/descriptive text of general interest (900-1000 words). Mix True/False/Not Given with note or summary completion.' },
  { no: 2, range: [14, 26], brief: 'a text on a work- or study-related topic with a clear argumentative structure (900-1000 words). Include Matching Headings and Matching Features.' },
  { no: 3, range: [27, 40], brief: 'a longer, more complex analytical text (1000-1100 words). Include Yes/No/Not Given, multiple choice, and summary completion.' },
];

const READING_GENERAL_PLAN = [
  { no: 1, range: [1, 14],  brief: 'Section 1 "social survival" — two or three short everyday texts (notices, advertisements, timetables), 700-800 words in total.' },
  { no: 2, range: [15, 27], brief: 'Section 2 "workplace survival" — two texts about job descriptions, contracts, staff training (800-900 words in total).' },
  { no: 3, range: [28, 40], brief: 'Section 3 "general reading" — one longer descriptive/instructive text of general interest (900-1000 words).' },
];

/** 產生一個聽力 section（10 題 + 完整逐字稿）*/
async function generateListeningSection({ no, range, brief, theme, testType, diff = '', userId }) {
  const system = `You are a senior IELTS item writer for Cambridge English. You write listening material that is
indistinguishable from the official papers: natural spoken English with hesitations, self-corrections and
speaker labels; distractors that punish careless listening; answers that appear verbatim in the transcript.

${SCHEMA_SPEC}

Return JSON:
{ "title": "Section ${no}",
  "instructions": "…the rubric a candidate sees at the top of this section…",
  "transcript": "…the FULL audio script, with speaker labels…",
  "groups": [ …one or more group objects covering EVERY question number in the range… ] }`;

  const user = `IELTS Listening Section ${no}.
Content: ${brief}
Question numbers: ${range[0]} to ${range[1]} inclusive — exactly ${range[1] - range[0] + 1} question numbers, none missing, none extra.
Theme / subject flavour: ${theme || 'authentic everyday and academic IELTS topics'}
Use two or three different question types within this section, as the real test does.
Every answer must appear in the transcript, in order. Respect every wordLimit you set.
${diff ? `\n${diff}` : ''}`;

  return ai.chat({ system, user, json: true, maxTokens: 12000, temperature: 0.8, purpose: 'generate_paper', userId });
}

/** 產生一篇閱讀（文章 + 13~14 題）*/
async function generateReadingPassage({ no, range, brief, theme, testType, diff = '', userId }) {
  const system = `You are a senior IELTS item writer for Cambridge English. You write ${testType === 'general' ? 'General Training' : 'Academic'}
reading material indistinguishable from the official papers.

${SCHEMA_SPEC}

Return JSON:
{ "title": "Reading Passage ${no}",
  "passageTitle": "…",
  "passage": "<p>…</p>",   // the FULL text, simple HTML. If any task needs paragraph letters,
                            // start paragraphs like <p><strong>A</strong> …</p>
  "instructions": "…",
  "groups": [ …group objects covering EVERY question number in the range… ] }`;

  const user = `IELTS ${testType === 'general' ? 'General Training' : 'Academic'} Reading Passage ${no}.
Content: ${brief}
Question numbers: ${range[0]} to ${range[1]} inclusive — exactly ${range[1] - range[0] + 1} question numbers, none missing, none extra.
Theme / subject flavour: ${theme || 'authentic IELTS topics'}
Use two or three different question types, as the real test does.
Every answer must be verifiable from the passage. Do not create trick items.
${diff ? `\n${diff}` : ''}`;

  return ai.chat({ system, user, json: true, maxTokens: 14000, temperature: 0.8, purpose: 'generate_paper', userId });
}

/** 產生寫作兩題 */
async function generateWritingTasks({ theme, testType, diff = '', userId }) {
  const system = `You are a senior IELTS item writer. Write the Writing module of a
${testType === 'general' ? 'General Training' : 'Academic'} paper.

Return JSON:
{ "title": "Writing",
  "groups": [{ "type": "writing_task", "questions": [
     { "number": 1, "taskNo": 1, "minWords": 150, "durationSec": 1200,
       "text": "…the exact task rubric the candidate sees…",
       ${testType === 'general'
    ? '"answers": [], "sampleAnswer": "a band 8-9 model letter"'
    : '"visualDescription": "describe the chart/table/process in enough detail that a teacher can draw it or generate an image", "answers": [], "sampleAnswer": "a band 8-9 model answer"'} },
     { "number": 2, "taskNo": 2, "minWords": 250, "durationSec": 2400,
       "text": "…the exact Task 2 prompt, including the instruction line…",
       "answers": [], "sampleAnswer": "a band 8-9 model essay" }
  ]}]}`;

  const user = `Theme / subject flavour: ${theme || 'authentic IELTS topics'}
Task 1: ${testType === 'general' ? 'a letter (formal, semi-formal or informal — state which)' : 'describe a chart, table, diagram or process'}.
Task 2: a discursive essay with a clear question type (opinion / discussion / problem-solution / two-part).
Write the rubrics exactly in official style. Model answers should be genuinely band 8-9.
${diff ? `\n${diff}` : ''}`;

  return ai.chat({ system, user, json: true, maxTokens: 8000, temperature: 0.8, purpose: 'generate_paper', userId });
}

/** 產生口說三部分 */
async function generateSpeakingSet({ theme, diff = '', userId }) {
  const system = `You are a senior IELTS speaking examiner and item writer.

Return JSON:
{ "title": "Speaking",
  "groups": [{ "type": "speaking_part", "questions": [
    { "part": 1, "topic": "…", "items": ["…","…","…","…"] },
    { "part": 1, "topic": "…", "items": ["…","…","…","…"] },
    { "part": 1, "topic": "…", "items": ["…","…","…","…"] },
    { "part": 2, "cueCard": { "topic": "Describe …", "bullets": ["You should say:","…","…","…","and explain …"], "prepSec": 60, "talkSec": 120 } },
    { "part": 3, "topic": "…", "items": ["…","…","…","…","…","…"] }
  ]}]}`;

  const user = `Theme / subject flavour: ${theme || 'authentic IELTS topics'}
Part 1: three familiar everyday topics, four questions each.
Part 2: one cue card, with the Part 2 topic linked to the Part 3 discussion.
Part 3: six abstract discussion questions that escalate in difficulty, clearly related to the Part 2 topic.
Write them exactly as an examiner would say them aloud.
${diff ? `\n${diff}` : ''}`;

  return ai.chat({ system, user, json: true, maxTokens: 6000, temperature: 0.85, purpose: 'generate_paper', userId });
}

/**
 * 分段產生整份試卷。
 * ctx 由 jobs.run 提供（setStep / savePartial / check），沒有的話就當作單純跑一次。
 */
async function generateFullPaper({ testType = 'academic', theme = '', difficulty = null, userId, ctx = null }) {
  const readingPlan = testType === 'general' ? READING_GENERAL_PLAN : READING_ACADEMIC_PLAN;
  const steps = [];

  // 老師選的難度翻成具體的出題指令。沒帶就用預設（band 6-7），
  // 行為跟以前完全一樣。
  const spec = diffLib.resolve(difficulty || {});
  const dp = (m) => diffLib.promptFor(m, spec, { testType });

  for (const s of LISTENING_PLAN) {
    steps.push({
      label: `聽力 Section ${s.no}（第 ${s.range[0]}–${s.range[1]} 題）`,
      run: () => generateListeningSection({ ...s, theme, testType, diff: dp('listening'), userId }),
      into: 'listening',
    });
  }
  for (const s of readingPlan) {
    steps.push({
      label: `閱讀 Passage ${s.no}（第 ${s.range[0]}–${s.range[1]} 題）`,
      run: () => generateReadingPassage({ ...s, theme, testType, diff: dp('reading'), userId }),
      into: 'reading',
    });
  }
  steps.push({ label: '寫作 Task 1 與 Task 2', run: () => generateWritingTasks({ theme, testType, diff: dp('writing'), userId }), into: 'writing' });
  steps.push({ label: '口說 Part 1–3', run: () => generateSpeakingSet({ theme, diff: dp('speaking'), userId }), into: 'speaking' });

  const collected = { listening: [], reading: [], writing: [], speaking: [] };
  const failed = [];

  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    ctx?.check();
    await ctx?.setStep(`${s.label}…（${i + 1}/${steps.length}）`, i);

    let section = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        section = await s.run();
        break;
      } catch (e) {
        ctx?.check();
        // 設定不完整（沒填金鑰、沒填模型）重試幾百次也不會變好，直接中止整份
        if (e.code === 'AI_NOT_CONFIGURED') { e.friendly = true; throw e; }
        if (attempt === 2) {
          // 單一段失敗不要整份丟掉——其他七、八段都是好的，
          // 老師拿回去補一段比重跑一次划算得多。
          failed.push(`${s.label}：${ai.friendlyError(e)}`);
        } else {
          await ctx?.setStep(`${s.label}… 第一次失敗，重試中（${i + 1}/${steps.length}）`, i);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
    if (section) {
      collected[s.into].push(section);
      await ctx?.savePartial(assemble(collected, { testType, theme, failed, spec }));
    }
  }

  await ctx?.setStep('組裝試卷…', steps.length);
  const paper = assemble(collected, { testType, theme, failed, spec });
  if (!collected.listening.length && !collected.reading.length
      && !collected.writing.length && !collected.speaking.length) {
    const err = new Error(failed.length
      ? `九個段落全部失敗。第一個錯誤：\n${failed[0]}`
      : 'AI 沒有產出任何內容');
    err.friendly = true;              // 已經是給人看的訊息了，不要再翻譯一次
    throw err;
  }
  return paper;
}

/** 把各段結果組成一份完整 paper */
function assemble(collected, { testType, theme, failed = [], spec = null }) {
  const modules = [];
  const push = (module, durationSec, sections) => {
    if (sections.length) modules.push({ module, durationSec, sections });
  };
  push('listening', 1800, collected.listening);
  push('reading', 3600, collected.reading);
  push('writing', 3600, collected.writing);
  push('speaking', 840, collected.speaking);

  const stamp = new Date().toISOString().slice(0, 10);
  // 難度寫進標題與說明，老師之後在試卷清單一眼就看得出這份是照什麼難度出的
  const lv = spec ? (diffLib.LEVELS[spec.level]?.label || spec.level) : null;
  const perMod = spec
    ? Object.entries(spec.modules).filter(([, v]) => v.overridden)
      .map(([k, v]) => `${MODULE_ZH[k] || k} ${diffLib.LEVELS[v.level]?.label || v.level}`)
    : [];
  return {
    title: `AI 模擬試卷${theme ? ` — ${theme}` : ''}${lv ? `（${lv}）` : ''}（${stamp}）`,
    testType,
    description: [
      failed.length
        ? `AI 產生，有 ${failed.length} 個段落失敗需要補：${failed.join('；')}`
        : 'AI 產生的完整模擬試卷，請人工校對後再指派。',
      lv ? `出題難度：${lv}${perMod.length ? `（${perMod.join('、')}另外指定）` : ''}` : '',
    ].filter(Boolean).join('\n'),
    generationIssues: failed,
    difficulty: spec || null,
    modules,
  };
}

// ── 2. 貼上原文 → 解析成系統格式 ───────────────────────────────
async function parsePasted({ text, moduleHint = '', answerKey = '', userId }) {
  const system = `You convert raw IELTS material that a teacher pasted (copied out of a PDF or Word file,
so the layout may be broken) into this system's JSON format.

${SCHEMA_SPEC}

Return JSON:
{ "module": "listening"|"reading"|"writing"|"speaking",
  "sections": [ { "title": "...", "instructions": "...", "passageTitle": "...", "passage": "<p>…</p>",
                  "transcript": "...", "groups": [ …group objects… ] } ],
  "notes": ["anything you were unsure about — the teacher will check these"] }

Rules:
- Preserve the original wording exactly. Do NOT rewrite the passage or the questions.
- Infer the correct "type" for every group from the rubric.
- Reconstruct broken tables/notes into bodyHtml with [[n]] gaps.
- If an answer key was supplied, attach the answers. If not, leave "answers": [] and add a note.
- Never invent answers you cannot justify from the source.`;

  const user = `Module hint: ${moduleHint || '(work it out yourself)'}

RAW MATERIAL:
"""
${text}
"""
${answerKey ? `\nANSWER KEY:\n"""\n${answerKey}\n"""` : '\n(No answer key supplied.)'}`;

  return ai.chat({ system, user, json: true, maxTokens: 24000, temperature: 0.2, purpose: 'parse', userId });
}

// ── 3. 寫作批改 ────────────────────────────────────────────────
const WRITING_DESCRIPTORS = `
Band descriptors you must apply (public version, abridged):

TASK ACHIEVEMENT (Task 1) / TASK RESPONSE (Task 2)
 9 fully satisfies all requirements; fully developed position/overview
 8 covers all requirements sufficiently; well developed with relevant, extended ideas
 7 addresses all parts; clear overview/position throughout; may over-generalise or lack focus in support
 6 addresses the requirements, though some parts more fully than others; relevant but inadequately developed
 5 generally addresses the task but format may be inappropriate; no clear overview / limited development
 4 attempts the task but does not cover all key features; may be irrelevant or repetitive
 3 does not adequately address any part of the task
 2 barely responds to the task
 1 answer is completely unrelated

COHERENCE AND COHESION
 9 cohesion attracts no attention; skilful paragraphing
 8 sequences information logically; manages all aspects of cohesion well
 7 logically organises with clear progression; uses a range of cohesive devices, occasionally over/under-used
 6 arranges information coherently, clear overall progression; cohesive devices used effectively but mechanically
 5 some organisation but no clear progression; inadequate/inaccurate/over-use of cohesive devices
 4 information presented but not arranged coherently; basic cohesive devices, may be repetitive
 3 no logical organisation; very limited control of organisational features

LEXICAL RESOURCE
 9 wide range, natural and sophisticated control; rare minor slips only
 8 fluent and flexible; skilful use of uncommon items; occasional inaccuracies in word choice/collocation
 7 sufficient range for flexibility and precision; some awareness of style and collocation; occasional errors
 6 adequate range; attempts less common vocabulary with some inaccuracy; some errors in spelling/word formation but they do not impede communication
 5 limited range, minimally adequate; noticeable errors in spelling/word formation that may cause some difficulty
 4 basic vocabulary, repetitive or inappropriate; limited control of word formation, errors may strain the reader
 3 extremely limited range; little control of word formation/spelling

GRAMMATICAL RANGE AND ACCURACY
 9 wide range with full flexibility and control; rare minor slips only
 8 wide range; majority of sentences error-free; occasional non-systematic errors
 7 variety of complex structures; frequent error-free sentences; good control with a few errors
 6 mix of simple and complex forms; some errors in grammar and punctuation but they rarely reduce communication
 5 limited range of structures; attempts complex sentences but they tend to be less accurate; frequent errors
 4 very limited range; rare subordinate clauses; errors predominate; punctuation often faulty
 3 attempts sentence forms but errors in grammar and punctuation predominate and distort meaning

Penalties you must apply:
 - Under-length: Task 1 under 150 words, Task 2 under 250 words → reduce Task Achievement/Response.
 - Off-topic / memorised / not in own words → severe reduction.
 - Task 2 is weighted twice as heavily as Task 1 in the final Writing band.
`.trim();

async function gradeWriting({ taskNo, prompt, essay, testType = 'academic', minWords = 150, visualDescription = '', userId }) {
  const wordCount = String(essay || '').trim().split(/\s+/).filter(Boolean).length;

  const system = `You are a certified IELTS Writing examiner. Grade strictly and consistently with the official
public band descriptors. Do not be generous — a typical well-organised but unremarkable answer is Band 6.0-6.5.
Whole-number criterion scores only (0-9).

${WRITING_DESCRIPTORS}

Return JSON:
{
 "criteria": {"TA": 0-9, "CC": 0-9, "LR": 0-9, "GRA": 0-9},
 "band": number,                                 // average of the four, rounded to nearest 0.5
 "summary_zh": "3-4 句中文總評",
 "summary_en": "3-4 sentence examiner comment",
 "byCriterion": {
   "TA": {"score":n,"why_zh":"...","evidence":["原文引述"],"howToImprove_zh":"..."},
   "CC": {...}, "LR": {...}, "GRA": {...}
 },
 "corrections": [
   {"original":"exact sentence from the essay","corrected":"improved version","issue_zh":"錯在哪（文法/搭配/用詞…）","severity":"minor|major"}
 ],
 "upgrades": [
   {"original":"basic phrase used","suggestion":"higher-band alternative","note_zh":"為什麼更好"}
 ],
 "wordCount": ${wordCount},
 "modelAnswer": "a Band 8-9 model answer to the same prompt, ~${taskNo === 1 ? 180 : 290} words",
 "nextSteps_zh": ["3-5 條具體、可執行的練習建議"]
}`;

  const user = `Test type: ${testType === 'general' ? 'General Training' : 'Academic'}
Task ${taskNo} (minimum ${minWords} words). Candidate wrote ${wordCount} words.

TASK PROMPT:
"""
${prompt}
"""
${visualDescription ? `\nWHAT THE CHART/DIAGRAM SHOWS (the candidate saw the visual; use this to judge factual accuracy and whether key features were selected):\n"""\n${visualDescription}\n"""\n` : ''}
CANDIDATE'S ANSWER:
"""
${essay}
"""`;

  const result = await ai.chat({ system, user, json: true, maxTokens: 12000, temperature: 0.3, purpose: 'grade_writing', userId });
  result.wordCount = wordCount;
  return result;
}

// ── 4. 口說評分 ────────────────────────────────────────────────
const SPEAKING_DESCRIPTORS = `
FLUENCY AND COHERENCE
 9 speaks fluently with only rare repetition/self-correction; hesitation is content-related; fully coherent
 8 fluent with only occasional repetition or self-correction; develops topics coherently and appropriately
 7 speaks at length without noticeable effort; some hesitation/repetition; uses a range of connectives flexibly
 6 willing to speak at length though may lose coherence at times through repetition/self-correction/hesitation
 5 usually maintains flow but uses repetition, self-correction and/or slow speech; may over-use connectives
 4 cannot respond without noticeable pauses; frequent repetition and self-correction; links only basic sentences
 3 speaks with long pauses; limited ability to link simple sentences

LEXICAL RESOURCE
 9 full flexibility and precise use in all topics; idiomatic language used naturally and accurately
 8 wide resource used readily and flexibly; skilful paraphrase; effective use of less common and idiomatic items
 7 flexible vocabulary to discuss a variety of topics; some less common and idiomatic items with occasional inaccuracy
 6 wide enough resource to discuss topics at length; generally paraphrases successfully despite inappropriacies
 5 manages to talk about familiar and unfamiliar topics but with limited flexibility; attempts paraphrase with mixed success
 4 able to talk about familiar topics only; frequent errors in word choice; rarely attempts paraphrase
 3 simple vocabulary to convey personal information; insufficient for less familiar topics

GRAMMATICAL RANGE AND ACCURACY
 9 full range used naturally and appropriately; rare minor slips only
 8 wide range flexibly; majority of sentences error-free; occasional inappropriacies/basic non-systematic errors
 7 range of complex structures with some flexibility; frequent error-free sentences though some errors persist
 6 mix of short and complex forms but limited flexibility; errors in complex structures rarely impede
 5 basic sentence forms with reasonable accuracy; limited range of complex structures which usually contain errors
 4 basic sentence forms and some correct simple sentences; subordinate structures rare; errors are frequent
 3 attempts basic sentence forms with limited success; numerous errors except in memorised expressions

PRONUNCIATION  (judge from the transcript's evidence + any noted transcription difficulty; be explicit that
audio-only features are estimated when you only have a transcript)
 9 uses a full range of features with precision and subtlety; effortless to understand
 8 wide range of features; sustained flexible use with occasional lapses; easy to understand, L1 accent minimal
 7 range of features with some effective use; can generally be understood throughout; occasional mispronunciation
 6 a range of features with mixed control; generally understood though individual words/sounds reduce clarity
 5 features used with limited control; can usually be understood but mispronunciation reduces clarity at times
 4 limited range; frequent mispronunciation causes some difficulty for the listener
 3 shows some features of band 2 and some of band 4
`.trim();

async function gradeSpeaking({ responses, userId, hasAudioFeatures = false, strictness = '' }) {
  /* part 0 是「整場錄音」那一列（只存音檔路徑，沒有逐字稿）。
     混進來的話等於多一題空白答案，會把分數往下拉。 */
  responses = (responses || []).filter((r) => Number(r.part) > 0);
  const transcriptBlock = responses
    .map((r) => `--- Part ${r.part}${r.q_index != null ? ` Q${r.q_index + 1}` : ''} (${r.duration_sec || 0}s)
EXAMINER: ${r.question || '(cue card)'}
CANDIDATE: ${r.transcript || '(no speech captured)'}`)
    .join('\n\n');

  const totalWords = responses.reduce((n, r) => n + String(r.transcript || '').split(/\s+/).filter(Boolean).length, 0);
  const totalSec = responses.reduce((n, r) => n + (r.duration_sec || 0), 0);
  const wpm = totalSec ? Math.round((totalWords / totalSec) * 60) : 0;

  const system = `You are a certified IELTS Speaking examiner. Grade the whole interview using the official
public band descriptors. Whole-number criterion scores only (0-9). Be strict and consistent — an intelligible,
adequately developed but unremarkable performance is Band 6.0.

${SPEAKING_DESCRIPTORS}

${hasAudioFeatures ? '' : 'You are working from transcripts only, so treat the Pronunciation score as an ESTIMATE based on speech rate, fillers, self-correction and transcription confidence, and say so in the pronunciation comment.'}
${strictness ? `MARKING POLICY SET BY THE SCHOOL: ${strictness}` : ''}

Return JSON:
{
 "criteria": {"FC":0-9,"LR":0-9,"GRA":0-9,"PRO":0-9},
 "band": number,
 "summary_zh": "3-4 句中文總評",
 "summary_en": "3-4 sentence examiner comment",
 "byCriterion": {"FC":{"score":n,"why_zh":"…","evidence":["逐字稿引述"],"howToImprove_zh":"…"},"LR":{…},"GRA":{…},"PRO":{…}},
 "byPart": {"1":{"comment_zh":"…"},"2":{"comment_zh":"…"},"3":{"comment_zh":"…"}},
 "corrections":[{"original":"what the candidate said","corrected":"natural version","issue_zh":"…"}],
 "upgrades":[{"original":"basic expression","suggestion":"band 8 alternative","note_zh":"…"}],
 "nextSteps_zh":["3-5 條具體練習建議"],
 "stats": {"words": ${totalWords}, "seconds": ${totalSec}, "wpm": ${wpm}}
}`;

  const user = `Speech rate across the whole interview: ${wpm} words/minute (native IELTS candidates at Band 7+ typically sit at 120-160 wpm).

INTERVIEW TRANSCRIPT:
${transcriptBlock}`;

  return ai.chat({ system, user, json: true, maxTokens: 10000, temperature: 0.3, purpose: 'grade_speaking', userId });
}

/**
 * 即時評分：考試進行中每隔幾輪更新一次的粗估分數。
 * 刻意用短提示、低 token，讓延遲控制在 2 秒內。
 */
async function scoreSpeakingLive({ transcript, seconds = 0, final = false, userId, strictness = '' }) {
  const system = `You are an IELTS Speaking examiner giving a RUNNING estimate mid-test.
Score what you have heard so far against the official criteria (whole numbers 0-9):
FC fluency & coherence, LR lexical resource, GRA grammatical range & accuracy, PRO pronunciation
(estimated from speech rate, fillers and self-correction, since you only have a transcript).
Be strict and stable — do not swing wildly between updates. An adequate but unremarkable
performance is 6.
${strictness ? `MARKING POLICY SET BY THE SCHOOL: ${strictness}` : ''}

Return JSON only:
{"criteria":{"FC":n,"LR":n,"GRA":n,"PRO":n},"band":n.n,"note_zh":"一句話中文評語（20 字內）"}`;

  const user = `Elapsed: ${seconds}s. ${final ? 'This is the END of the test.' : 'The test is still in progress.'}

${transcript.slice(-6000)}`;

  return ai.chat({
    system, user, json: true, maxTokens: 400, temperature: 0.2,
    purpose: 'score_live', userId,
  });
}

/** 讓 Part 1 / Part 3 會依考生回答追問，更像真人 */
async function speakingFollowUp({ part, topic, history, userId }) {
  const system = `You are an IELTS Speaking examiner conducting Part ${part}. Ask ONE next question only.
Part 1: short, familiar, personal questions. Part 3: abstract, opinion-based, follow the candidate's line of thought.
Never evaluate, never give feedback, never say more than the question itself (a very short natural
acknowledgement like "Right." before the question is fine). Return JSON: {"question":"…"}`;
  const user = `Topic: ${topic}
Conversation so far:
${history.map((h) => `EXAMINER: ${h.question}\nCANDIDATE: ${h.transcript || '(silence)'}`).join('\n')}

Give the next question.`;
  const out = await ai.chat({ system, user, json: true, maxTokens: 300, temperature: 0.8, purpose: 'speaking_followup', userId });
  return out.question || '';
}

module.exports = {
  generateQuestions, generateFullPaper, generateSpeakingSet, parsePasted,
  gradeWriting, gradeSpeaking, scoreSpeakingLive, speakingFollowUp,
  WRITING_DESCRIPTORS, SPEAKING_DESCRIPTORS,
};
