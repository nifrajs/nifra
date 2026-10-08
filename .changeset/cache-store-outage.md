---
"@nifrajs/cache": minor
"@nifrajs/web": minor
---

`cache.wrap` loads through a store outage: a store `get` that throws or rejects is a miss, so the loader answers, and a failed `set` still returns the loaded value. Failures go to the new `onStoreError(error, { op })`, which by default logs one line per operation per minute without the key. The explicit `get`, `set`, `delete`, `invalidateTag` and `clear` still reject. `revalidateEndpoint` takes `dataCaches`, caches such as a `@nifrajs/cache` holding loader data: a tag purge invalidates each of them before the page store and the CDN, and a failure answers `500` before the page store is touched. `createInvalidator` from `@nifrajs/web/cdn` takes the same `dataCaches`.
