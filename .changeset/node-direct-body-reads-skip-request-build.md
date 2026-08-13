---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

A direct body read on Node - `c.req.json()`, `c.req.text()`, `c.req.arrayBuffer()`, `c.req.bytes()`
on a raw-body route - now reads straight off the socket instead of first building the Web `Request`
the adapter had been deferring. The body cap is unchanged and still enforced by the same bounded
reader: an over-cap `Content-Length` is rejected before buffering, a chunked body is still aborted
mid-stream rather than buffered first, `clone()` inherits the cap, and `c.boundedBody(explicit)`
still overrides it in either direction. `c.req` keeps its identity and every other member behaves
as before. Net: a raw-body `POST` that reads through `c.req` gets a large throughput gain - roughly
+65% on the JSON-body workload in the Bun HTTP framework benchmark on Node - and is no longer the
slowest lane in a nifra app.
