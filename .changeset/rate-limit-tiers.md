---
"@nifrajs/middleware": minor
---

`rateLimitTiers({ store, floor, tiers })` charges each request to exactly one bucket: the tier with the longest static prefix that holds the request path, else the floor. Tiers never stack on the floor, so a tier may allow more than it. It runs before routing, so 404s, 405s and bodies that fail validation are charged; prefixes are validated when the limiter is built; each tier counts in its own store keys; and every instance has its own name, so `use()` and `merge()` never drop one. `rateLimit()` gains `skip(req, platform)`, which leaves a request uncharged and without `RateLimit-*` headers.
