---
"@nifrajs/core": patch
---

`DurableObjectRecordBackend.scan` returns every matching record when a reconciliation walk follows its cursor. A page that filled up now resumes after its own last record, where the cursor skipped the next matching record at each page boundary. `MemoryDurableRecordBackend.scan` sorts ids in the same code-unit order its cursor compares with, so mixed-case ids are no longer skipped either.
