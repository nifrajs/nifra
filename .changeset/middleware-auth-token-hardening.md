---
"@nifrajs/middleware": patch
"@nifrajs/auth": patch
---

fix(middleware, auth): CSRF behind TLS proxies, CORS caching, and token parsing

The CSRF same-origin default in `csrf()` from both packages accepts an `https:` Origin on an `http:`
request URL, which is what a TLS-terminating proxy presents. A downgrade or another host is still
rejected.

`cors()` with an allowlist or predicate sends `Vary: Origin` on every response, including ones that
carry no `Access-Control-Allow-Origin`.

`jwt()` and `verifyCsrfToken()` accept only canonical base64url signatures. `jwt()` and `bearer()`
match the `Bearer` auth-scheme case-insensitively.
