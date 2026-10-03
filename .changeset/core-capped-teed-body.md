---
"@nifrajs/core": patch
---

A length-less request body over its cap is answered with 413 promptly when the body was cloned first: through the transport codec lane, an idempotency `namespace` resolver, or a `c.req.clone()` read on a capped route.
