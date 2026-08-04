---
"@nifrajs/core": patch
"@nifrajs/web": patch
---

Improve hot paths across runtimes and the browser: a validated-POST fused lane for Bun/Deno Web
requests (measured +12.7% Deno, +3.5% Bun on `POST /users`; Node-direct is unaffected on purpose,
it has its own socket serializer), client route matching indexed on the core router instead of a
linear scan (measured ~18x faster on a 100-route app), search-param parsing in one pass instead of
O(keys²), and allocation-free fast paths for static asset URLs and safe SSR script serialization.
