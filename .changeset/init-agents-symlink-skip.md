---
"@nifrajs/cli": patch
---

`nifra init-agents` now reports a symlinked agent file (a `CLAUDE.md` aliased to `AGENTS.md`, say) as left alone and writes the rest, instead of stopping the whole run. It still never writes through a symlink.
