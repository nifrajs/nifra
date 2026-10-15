---
"@nifrajs/web": patch
---

Page documents render with less work per request. Loader data that a closed output schema has settled skips the scan for deferred values. The request origin is parsed once per host. An empty query string skips search parsing. The render options are assembled without a copy per optional field. On the SSR bench apps this measured 6 to 10% more requests per second on Bun and Node.
