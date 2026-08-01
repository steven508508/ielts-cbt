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
Target difficulty: ${difficulty}
Number of question numbers to produce: ${count}
Question numbering starts at: ${startNumber}
Section: ${sectionNo}
${passage ? `\nBase the questions STRICTLY on this passage:\n"""\n${passage}\n"""` : ''}
${transcript ? `\nBase the questions STRICTLY on this listening transcript:\n"""\n${transcript}\n"""` : ''}
${extra ? `\nExtra requirements: ${extra}` : ''}
${wants.join('\n')}

Every answer must be findable in the source text. Do not create trick items.`;

  const out = await ai.chat({ system, user, json: true, maxTokens: 12000, temperature: 0.8, purpose: 'generate', userId });
  return out;
}

/** 產生一整份試卷骨架（四科），供老師再微調 */
async function generateFullPaper({ testType = 'academic', theme = '', userId }) {
  const system = `You are a senior IELTS item writer. Produce a COMPLETE ${testType === 'general' ? 'General Training' : 'Academic'} practice paper outline.
${SCHEMA_SPEC}

Return JSON shaped exactly like:
{ "title": "...", "testType": "${testType}", "description": "...",
  "modules": [
    {"module":"listening","durationSec":1800,"sections":[{"title":"Section 1","instructions":"...","transcript":"...","groups":[…]}]},
    {"module":"reading","durationSec":3600,"sections":[{"title":"Reading Passage 1","passageTitle":"...","passage":"<p>…</p>","groups":[…]}]},
    {"module":"writing","durationSec":3600,"sections":[{"title":"Writing","groups":[{"type":"writing_task","questions":[{"number":1,"taskNo":1,"minWords":150,"durationSec":1200,"prompt":"...","sampleAnswer":"..."}]}]}]},
    {"module":"speaking","durationSec":840,"sections":[{"title":"Speaking","groups":[{"type":"speaking_part","questions":[{"part":1,"topic":"...","items":["…"]},{"part":2,"cueCard":{"topic":"Describe …","bullets":["…"],"prepSec":60,"talkSec":120}},{"part":3,"topic":"...","items":["…"]}]}]}]}
  ]}`;

  const user = `Theme / subject flavour: ${theme || 'mixed authentic IELTS topics'}
Listening: 4 sections, 40 questions total, with full transcripts.
Reading: 3 passages, 40 questions total, with full passages.
Writing: Task 1 (${testType === 'general' ? 'a letter' : 'describe a chart/process — describe the visual in words under "visualDescription" so a teacher can draw or generate it'}) + Task 2 essay.
Speaking: Part 1 (3 topics x 4 questions), Part 2 cue card, Part 3 (5-6 discussion questions).
Vary the question types across the official range. Keep every answer verifiable.`;

  return ai.chat({ system, user, json: true, maxTokens: 32000, temperature: 0.8, purpose: 'generate_paper', userId });
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

async function gradeSpeaking({ responses, userId, hasAudioFeatures = false }) {
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
async function scoreSpeakingLive({ transcript, seconds = 0, final = false, userId }) {
  const system = `You are an IELTS Speaking examiner giving a RUNNING estimate mid-test.
Score what you have heard so far against the official criteria (whole numbers 0-9):
FC fluency & coherence, LR lexical resource, GRA grammatical range & accuracy, PRO pronunciation
(estimated from speech rate, fillers and self-correction, since you only have a transcript).
Be strict and stable — do not swing wildly between updates. An adequate but unremarkable
performance is 6.

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
  generateQuestions, generateFullPaper, parsePasted,
  gradeWriting, gradeSpeaking, scoreSpeakingLive, speakingFollowUp,
  WRITING_DESCRIPTORS, SPEAKING_DESCRIPTORS,
};
