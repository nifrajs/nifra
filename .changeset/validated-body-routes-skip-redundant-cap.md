---
"@nifrajs/core": patch
---

A route that validates its body no longer arms the direct-read body cap on `c.req`. That lane
already reads and bounds the body - at the route's own limit - before any derive, hook, or handler
runs, so on a validated route the extra per-request cap only ever guarded a body that was already
consumed. Dropping it removes a per-request write on the request object that, on V8, reshaped it
every request and fed avoidable GC churn. Raw-body routes (no body schema), where a direct `c.req`
read is the only body boundary, keep the cap exactly as before. Net: lower per-request allocation
and a markedly tighter tail on validated `POST`/`PUT` routes, most visible on Deno.
