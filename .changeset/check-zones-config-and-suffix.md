---
"@nifrajs/cli": patch
---

`nifra check`'s zone rules (NF-C028, NF-C029, NF-C032 and the data guards) see every file the build zones. A file outside `routes/`, `frontend/`, `backend/` and `shared/` was skipped, so a folder declared in `"nifra": { "zones": { "frontend": [...] } }` and a `lib/x.frontend.ts` file could read private environment variables or carry a secret key without a finding. Such a file now belongs to the nearest app around it. A relative project root passed to `collectCheckResult` is resolved first; before, it left every file unzoned.
