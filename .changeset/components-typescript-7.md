---
"@nifrajs/web": patch
"@nifrajs/cli": patch
---

Server components and `nifra check` no longer crash on a project that installs TypeScript 7. TypeScript 7's package exports only `version`, with no in-process compiler API, so loading the component pipeline used to fail with a TypeError on first use. The pipeline now raises `NIFRA_TS_UNSUPPORTED` with the fix: pin the project to TypeScript 6. `nifra check` reports the same code. It gives no component module a receipt, so each one is checked as an ordinary backend import. The pipeline reads `componentPipeline` from a config file through `staticComponentPipeline` in `@nifrajs/web/server-components/source`.
