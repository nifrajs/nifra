---
"@nifrajs/middleware": patch
"@nifrajs/auth": patch
---

Each guard you build is its own plugin: `bearer()`, `basicAuth()`, `jwt()`, `ipRestriction()`, `rateLimit()`, `csrf()` and `bodyLimit()`. A second, stricter one before later routes or inside a `group()` applies alongside the first. The same instance passed to `use()` twice still applies once.
