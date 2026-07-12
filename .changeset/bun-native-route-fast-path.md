---
"@nifrajs/core": patch
"@nifrajs/budget": patch
---

Compile eligible Nifra routes into Bun's native route table while preserving the existing lifecycle
and portable-router fallback. Reuse unbounded request state, avoid wall-clock admission work when no
deadline exists, lazily parse native-route queries, and inspect only captured parameter values.
