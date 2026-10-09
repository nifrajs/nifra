---
"@nifrajs/cli": patch
---

The `nifra check` help and the CLI README now say that with a `contracts.lock.json`, `nifra check` imports `backend/app.ts`, running its top-level code, in `--lints-only` mode too, to compare the routes it serves against the lock. They described the gate as static only.
