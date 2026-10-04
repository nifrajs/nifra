---
"@nifrajs/coding-agent": minor
---

The orchestration evidence digest (`evidenceDigest`, `EvidenceStore.digest()`) now counts repeated records. A run whose node retried before succeeding no longer has the same digest as a clean run. Previously retries with an even number of repeats cancelled out. The digest is still independent of record order, `seq`, timing and run id. Digests recorded by earlier versions do not match the new ones, so re-record any stored baselines.
