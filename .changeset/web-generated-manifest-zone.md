---
"@nifrajs/web": patch
---

A generated `server-manifest.ts` counts as framework output wherever the build writes it, so `nifra check` and editor diagnostics no longer report its route imports when it sits under `backend/`.
