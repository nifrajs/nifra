---
"@nifrajs/core": patch
"@nifrajs/web": patch
---

Improve hot paths across runtimes and the browser: a validated-POST fused lane for Bun/Deno Web
requests (measured +12.7% Deno, +3.5% Bun on `POST /users`) plus a registration-compiled body
validation/handler continuation shared by Web and Node-direct (about 9.6% faster than the generic
body lane in-process), client route matching indexed on the core router instead of a linear scan
(measured ~18x faster on a 100-route app), search-param parsing in one pass instead of O(keys²), and
allocation-free fast paths for static asset URLs and safe SSR script serialization.
Node serving now keeps synchronous Web request middleware on the direct renderer, adapts in-place Web
response middleware back to direct buffered writes, and avoids redundant params/body lifecycle stages
for common validated reads. Header-only built-ins (`cache-control`, `powered-by`, and related response
mutators) no longer clone buffered responses on Node.
