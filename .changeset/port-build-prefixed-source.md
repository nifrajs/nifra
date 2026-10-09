---
"@nifrajs/cli": patch
---

`nifra port` now scans a source file whose name only starts with "build" (such as `buildings.ts`). It still skips build scripts: `build.ts`, `build-<target>.ts` and `build.<name>.ts`.
