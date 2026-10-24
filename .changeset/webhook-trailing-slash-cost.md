---
"@nifrajs/core": patch
"@nifrajs/middleware": patch
---

`verifyWebhook` computes the expected HMAC once per secret and compares it to every signature the header lists, so a Stripe header carrying many `v1=` entries no longer costs one HMAC over the body per entry. `trimTrailingSlash` strips a trailing run of slashes in linear time; a long run of slashes inside the path no longer costs time quadratic in its length.
