---
"@nifrajs/core": minor
"@nifrajs/auth": minor
"@nifrajs/middleware": minor
---

Signing-secret rotation. `signValue`/`unsignValue` (and the new `CookieSecret` type), session `secret`, and CSRF `secret` now also accept a rotation list: the first secret signs, any listed secret verifies, so keys rotate without invalidating live cookies, sessions, or CSRF tokens. Every listed secret must meet the 32-byte floor and an empty list throws; the single-secret path is unchanged.
