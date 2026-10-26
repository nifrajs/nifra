---
"@nifrajs/middleware": minor
---

A `rateLimitTiers` tier's `prefix` can be a list, and every prefix in it charges the tier's one bucket, so `{ prefix: ["/api/exports", "/api/reports/download"], max: 30 }` allows 30 a window across both paths. The tier with the longest matching prefix across every tier's list is still the one charged, and a prefix listed twice, in one tier or in two, is refused when the limiter is built. A tier's new `name` sets its bucket's store scope (`tier:<name>:`); it defaults to the first prefix, so a tier named or listing its old prefix first keeps its live counters when the list changes. Two tiers with one name are refused. Rate-limit route evidence covers the routes under every listed prefix.

`rateLimit` and `rateLimitTiers` now return a `RateLimiter`, a middleware with `keyOf(request, platform?)`: it resolves to the store key the request would be charged to, running a custom or async key and its client-IP fallback as a request would, or `undefined` when the request would be skipped, unclaimed with no floor, or unkeyable. It counts nothing.
