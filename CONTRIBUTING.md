# Contributing / 參與開發

Thanks for taking a look. Issues and pull requests are both welcome, in English or
Traditional Chinese — use whichever you are comfortable with.

歡迎開 issue 與 PR，英文或中文都可以。

---

## Before you start

**Small fixes** (typos, an obviously wrong condition, a missing null check) — just
open a PR. No need to ask first.

**Anything that changes what a student sees during an exam** — please open an issue
first. This project runs real exams; a change that looks like an improvement can cost
a student marks. Describe what you saw, on which module, and what you expected.

## Setting up

```bash
npm install
cp .env.example .env      # set DB_*, JWT_SECRET
npm run init-db && npm run seed
npm start                 # http://localhost:3000
```

Accounts after seeding: `admin / admin1234`, `teacher1 / teach1234`,
`student1..5 / ielts1234`.

There is no build step on the front end. Edit a file under `public/`, refresh, done.

## Running the tests

```bash
npm test              # unit — fast, no server needed
npm run test:e2e      # API end-to-end — needs the server running
npm run test:security # authorisation, IDOR, upload safety
npm run test:scope    # class isolation
npm run test:browser  # Playwright — rendering, audio, saving, figures, speaking
npm run test:all
```

Playwright is deliberately **not** a dependency (a production server should not
install a browser). Install it only when you need the browser suites:

```bash
npm i -D playwright && npx playwright install chromium
```

## What a good change looks like here

This project has a particular failure mode, and most of its history is about it:
**the feature is broken but the screen looks completely normal, and every API test is
green.** A few real examples:

- The microphone worklet was never connected to the audio graph, so the student's
  voice was never captured — the UI showed a working conversation.
- A stale layout field made an entire question group render as nothing, while the
  question-number bar at the bottom still listed all of them.
- Answers that failed to save were dropped silently; the bar still showed them as
  answered because it counted from memory.

So:

- **Measure what the student sees.** If a change touches rendering, timing, audio or
  saving, add a browser test that asserts the observable outcome — pixels, computed
  styles, real mouse events, what actually reached the database. `test/browser/`
  has examples of each.
- **Prove the test catches the bug.** Break the fix on purpose, watch the test fail,
  then restore it. A regression test that passes on the broken code is worse than none.
- **Make failures loud.** If something can go wrong in a way the student cannot see,
  tell them on screen and report it so the teacher can find it later.
- **Don't silently swallow.** Empty `catch {}` around anything that touches a
  student's answers is how data disappears.

## Style

- The code and comments are mostly in Traditional Chinese; new code can be in either
  language. Keep comments in whatever language the surrounding file uses.
- Comments should explain **why**, especially the failure that motivated the code.
  `// 這裡以前是 X，導致 Y` is much more useful to the next person than `// 設定 X`.
- Plain JavaScript, no framework, no bundler. Please keep it that way — the whole
  point is that a teacher with a cheap VPS can run and modify this.
- Runtime dependencies are kept to a minimum. Think hard before adding one.

## Pull requests

- One topic per PR.
- Say what you observed, not just what you changed.
- Run `npm test` and, if you touched the front end, the relevant browser suite.
- Never commit `.env`, keys, tokens, real student data, or recordings.

## Translations

The full manual is currently only in Traditional Chinese. A translation — or even a
partial one covering setup and question formats — is one of the most useful
contributions right now. Add `README.<lang>.md` and link it from the language line
at the top of the other READMEs.
