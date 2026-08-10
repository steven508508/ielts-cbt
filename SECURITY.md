# Security Policy / 安全性

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting: **Security → Report a vulnerability** on this
repository. If that is unavailable, open an issue titled only "security contact
request" with no details, and a maintainer will reply with a private channel.

Please include: what you can do with it, the steps to reproduce, and the version or
commit. A proof of concept helps a lot. You will get an acknowledgement within a few
days.

安全性問題請不要開公開 issue。請用 GitHub 的 **Security → Report a vulnerability**
私下回報。

## Scope

This software runs real exams and stores students' answers, essays and voice
recordings. The things that matter most here:

- **Authorisation** — a student reaching another student's attempt, results,
  transcript or recording; a teacher reaching a class they do not manage
- **Answer-key exposure** — anything that leaks correct answers, explanations or
  listening transcripts to a student during an exam
- **Upload handling** — anything that lets a user place executable or same-origin
  content under `/uploads`
- **Authentication** — token forgery, tokens that survive a password change,
  privilege escalation
- **Exam integrity** — bypassing the server-side timer, submitting after time,
  altering another candidate's submission

## Running it safely

If you deploy this:

- Set a real `JWT_SECRET` (`openssl rand -hex 32`). The server warns loudly in
  production if it is still the default.
- Change the seeded `admin` password before the server is reachable.
- Put it behind HTTPS. Microphone access requires a secure context, and the file
  cookie is only marked `Secure` in production.
- Do not expose the database port.
- Keep AI provider keys in `.env` — never in the repository. The admin UI returns
  masked values and never sends a key back to the browser.

## Supported versions

Only the latest release receives fixes. There is a single maintainer; please do not
rely on backports.
