---
"@nifrajs/core": minor
"@nifrajs/middleware": patch
"@nifrajs/web": patch
---

`requestLocal<T>()` from `@nifrajs/core/server` is a per-request slot with `get`, `set`, `has` and `delete` whose value follows the request through the copies nifra makes of it: a `mount()` that strips its prefix, a mount's WebSocket pass reused for HTTP, a request target nifra resolves, the transport-codec and idempotency lanes, `methodOverride()`, a rewriting `trimTrailingSlash()` or `appendTrailingSlash()`, a live load, and the owner page's re-render after a progressive action. Every copy shares one scope: a value set before a mount is read in the child, and one the child sets is read through the parent's request. `carryRequestLocals(from, to)` joins a request a wrapper or an `onRequest` hook rebuilt to the same scope; a copy made without it starts empty. Values are held weakly and never cross requests. Make slots at startup: copies are linked only once a first slot exists, so a request copied before then starts empty.
