---
"@nifrajs/core": patch
"@nifrajs/schema": patch
---

A 422 validation response lists at most the first 100 issues, and `t` schemas stop collecting issues at 100, so a large invalid body cannot produce a response many times its own size.
