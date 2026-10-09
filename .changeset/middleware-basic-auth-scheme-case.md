---
"@nifrajs/middleware": patch
---

`basicAuth()` accepts the `Authorization` scheme in any letter case, as HTTP defines it. A client that sent `basic` or `BASIC` with valid credentials was answered 401; it is now let in, like `Basic`.
