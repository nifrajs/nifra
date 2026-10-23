---
"@nifrajs/core": patch
---

On Bun, a Host that Node and Deno refuse with 400 `invalid_host` but that Bun built the request URL on
anyway (a sub-delimiter such as `a!b` or `a.example,b.example`, or a percent-encoded name such as
`%61.example`, which Bun routed as `a.example` while the header still read `%61.example`) answers 400
`invalid_host` too. The check covers the native route table and WebSocket handshakes; a request built in
process keeps the URL its caller built unless that URL is the one Bun builds on its Host.
