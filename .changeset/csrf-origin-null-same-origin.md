---
"@nifrajs/middleware": patch
"@nifrajs/auth": patch
---

`csrf()` (middleware and auth) accepts a same-origin HTML form POST sent under `Referrer-Policy: no-referrer`, which `securityHeaders()` sets by default. Such a form arrives with `Origin: null`, and every one was refused with 403. A request with `Origin: null` now passes only when the browser's own `Sec-Fetch-Site` header says `same-origin`, and only in the default same-origin mode; an explicit `origins` allowlist still refuses it.
