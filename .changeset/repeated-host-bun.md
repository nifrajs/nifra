---
"@nifrajs/core": patch
---

On Bun, a request with two Host fields answers 400 `invalid_host`, as on Deno and `@nifrajs/node` and as
RFC 9112 section 3.2 requires. Bun.serve routed it on the first Host and handed the app both, joined with
", ", so a handler that read Host saw an authority the request was not routed on. The check covers the
native route table and WebSocket handshakes too; a request built in process keeps the URL its caller
built, unless it pairs two Hosts with a URL on the first, as Bun hands such a request over.
