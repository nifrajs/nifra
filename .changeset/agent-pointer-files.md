---
"create-nifra": minor
"@nifrajs/cli": minor
---

feat: AGENTS.md is the one copy of an app's agent guidance

A scaffold and `nifra init-agents` write `AGENTS.md` plus a pointer to it for each agent:
`CLAUDE.md` and `GEMINI.md` import it, `.cursor/rules/nifra.mdc` is an always-applied Cursor rule
that attaches it, and `.github/copilot-instructions.md` names it. None of them carries guidance of its
own, so they cannot drift apart. A web app's `AGENTS.md` gains a "Project structure" section on the
frontend/backend zones the build enforces, and `nifra init-agents` appends it to an app with `routes/`.
