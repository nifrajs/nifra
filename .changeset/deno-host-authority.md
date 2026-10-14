---
"@nifrajs/core": patch
---

On Deno, a request whose `Host` header is not an authority (a reg-name or IP literal with an optional port) is refused with `400 {"ok":false,"error":"invalid_host"}` before routing, as Node already refuses it. Deno builds `Request.url` by appending the target to the Host as received, so `GET /public` with `Host: x/admin#` was routed to `/admin`, and `c.req.url` carried the spoofed path. Reading the header costs a bare route on Deno about 4% of its throughput; a route that reads any header already paid it.
