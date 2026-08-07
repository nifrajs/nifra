---
"@nifrajs/web": minor
---

`KVCacheStore` accepts a `minExpirationTtl`. The 60-second floor is Cloudflare KV's, and it stays the default, but `KVNamespaceLike` is three structural methods that Redis, Deno KV and Upstash satisfy too - and those accept far shorter TTLs. Declare the binding's real minimum, or `0` for a backend without one. A non-integer or negative TTL is now rejected at construction rather than reaching the binding.
