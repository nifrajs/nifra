---
"@nifrajs/cli": patch
---

`nifra check` reads every `secretExemptions` entry in `nifra.config.ts` when a string in it holds a bracket, brace or colon, such as the file `routes/[lang]/index.tsx`, instead of dropping that entry and the ones after it.
