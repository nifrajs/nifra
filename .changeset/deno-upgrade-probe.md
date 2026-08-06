---
"@nifrajs/deno": patch
---

Stop reading the `Upgrade` header on every request. The adapter used that read as a pre-filter
before consulting the WebSocket seam, on the assumption it was cheaper than resolving an upgrade -
but the seam already answers "not an upgrade" on an app with no `ws()` routes by checking its own
route count, without touching headers at all. So the probe skipped nothing and instead forced the
runtime to materialize the request's header list for every plain HTTP request, including routes
that never read a header. Deno bills header access lazily, so that cost landed on requests which
would otherwise have paid nothing: measured at ~7% of throughput on a bare JSON route under Deno
2.9, ~4.5% under 2.8.

The seam is now bound once when the server starts and called directly, and the settled-outcome
handling moved out of the per-request closure so the common plain-HTTP path allocates nothing. On a
bare `GET` the adapter measures ~11% faster and now runs within a few percent of a hand-written
`Deno.serve` handler. Upgrade behavior is unchanged - a handshake still upgrades, an `upgrade()`
guard's rejection is still returned as an HTTP response, and a non-nifra `{ fetch }` handler still
skips the seam entirely - and the package gains its first WebSocket round-trip tests covering
exactly those paths.
