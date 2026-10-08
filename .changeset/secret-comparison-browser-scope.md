---
"@nifrajs/cli": major
---

`nifra check` reports a non-constant-time secret comparison (NF-S002) as advisory only for browser code inside a nifra web app: a directory with `nifra.config.ts` or `backend/framework.ts`, or whose nearest package.json depends on `@nifrajs/web` or a `@nifrajs/web-*` adapter. A `routes/` or `frontend/` file anywhere else, such as in an API-only project or a package without a web dependency, is server code, so the comparison fails the check. `nifra fix --code NF-S002` rewrites exactly the comparisons the check reports.
