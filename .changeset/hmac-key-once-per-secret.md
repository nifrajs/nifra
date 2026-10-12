---
"@nifrajs/core": patch
---

Signed cookies, and the `@nifrajs/auth` sessions built on them, import each secret's HMAC key once instead of on every sign and verify. A verify measured about 16% faster on Bun (one run). Up to 64 secrets are kept, and the list starts over past that.
