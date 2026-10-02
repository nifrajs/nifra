---
"@nifrajs/cli": patch
---

`nifra openapi` works on an API-only app: with no `nifra.config.ts` or `backend/framework.ts`, it reads `backend/app.ts` alone instead of asking for a UI adapter.
