---
"@nifrajs/cli": patch
---

`nifra sdk` generates the client for a backend whose routes it reads from `backend/app.ts`, instead
of failing before it writes anything.
