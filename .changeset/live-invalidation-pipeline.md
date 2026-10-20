---
"@nifrajs/web": minor
---

`revalidate(paths, data, { tags, keys })`: an action names the cache tags and live keys its write made stale, beside its paths. One pipeline invalidates them in order - data caches, the page store, the live publish, then the CDN - before the action answers. A data cache or page store failure stops it before anything is published; retries run for up to 2 s inline, or behind the response with `waitUntil`. `withISR` runs every stage (new `dataCaches`, `cdn` and `onInvalidationError` options); without it, an app with `live` publishes the keys and tags itself. `revalidateEndpoint` takes `live` and publishes the tags it purges. `live({ visible })` delays each publish until a read replica has the write. A quiet `renew` re-signs a grant at most twice before every loader runs again.
