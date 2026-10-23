---
"@nifrajs/web": minor
"create-nifra": patch
---

`withISR` signs the pages it keeps in a shared store. Over any store but `MemoryCacheStore` it takes a `storeSecret`, at least 32 characters and the same in every process, and refuses to start without one. Each page is stored with an HMAC-SHA-256 over its cache key, body, status, headers, tags and freshness, and a page whose signature is missing or does not match is a miss: it renders again and the signed render replaces it. Whoever else can write the store can no longer serve visitors a page the app did not render. `MemoryCacheStore` pages stay unsigned. `onStoreError` reports a failed check with the new op `"verify"`.

The ISR starter's Worker reads the secret from `ISR_STORE_SECRET` (`wrangler secret put ISR_STORE_SECRET`); `bun run dev` passes a local one.
