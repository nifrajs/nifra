---
"@nifrajs/core": patch
---

An idempotency `namespace` resolver receives the request's method, URL and headers, as its type says, instead of a full clone of the request. A resolver that read the clone's body could read past the route's body limit, and the clone kept a copy of the body alive. The resolver no longer gets a body at all.
