---
"@nifrajs/node": patch
---

Add an opt-in `serve({ fastResponse: true })`. With it on, a handler that returns a hand-rolled
`new Response(body)` with a string body rides the same direct-write lane `c.text` / `c.json` already
use: the reply reaches the socket from a status, a header record, and the bytes, instead of the
adapter draining a `Response` body stream. It works by swapping `globalThis.Response` for a stand-in
that defers a *simple* construction (a string body, no `statusText`, and no headers or a plain header
record) and builds a real `Response` for anything else (a stream, a `Blob`, `null`, a `Headers`
instance) unchanged. A simple response is byte-identical to before, including the `content-type` the
native constructor infers, and stays `instanceof Response`.

Off by default: `c.text` / `c.json` get the fast lane without any global change, so prefer them.
Reach for `fastResponse` only when handlers build `Response` by hand on a hot path - it patches a
process-global builtin, so every `new Response(...)` in the process goes through the stand-in.
