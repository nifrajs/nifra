---
"@nifrajs/middleware": patch
---

`idempotency()` no longer stores request rejections (400, 404, 405, 413, 414, 415, 422, 431) for replay, alongside the statuses it already skipped. Storing them let anyone fill a `MemoryIdempotencyStore` with fresh keys sent to a route that does not exist, after which every legitimate write got 503 until the entries expired a day later. A handler that answers 400 or 422 after a side effect can keep the old behavior with its own `shouldCache`.
