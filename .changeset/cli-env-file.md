---
"@nifrajs/cli": patch
---

`nifra` now accepts `--env-file <path>` on every command, repeatable, with later files winning and a variable already set in the process environment never overwritten.

Commands that reflect a project (`check`, `assure`, `levels`, `routes`, `capabilities`, `manifest`, `contracts`, `openapi`, `types`) do so by importing it, and a production-grade app validates its environment at module scope. Without that environment the app aborted the process before nifra reached its first check, so the entire output was the app's own `FATAL: invalid environment` with nothing tying it to the command that was run - an app whose environment lives in an uncommitted `.env.local` simply could not be checked. A missing `--env-file` is a hard error rather than a silent no-op, so a command never looks like it verified an environment it did not load.

When a reflected import kills the process anyway, the CLI now names the cause on the way out instead of leaving the app's bare abort as the only output.
