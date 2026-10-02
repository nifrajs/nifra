---
"@nifrajs/web": minor
---

`@nifrajs/web/cdn` puts a CDN in front of nifra pages and purges it by tag.

- `withCdn(app, { provider })` wraps an app or a `withISR` handler. Every page a shared cache may hold gets the CDN's tag header (the route's `revalidateTags` plus a tag for the page's path) and the CDN's TTL from the route's `revalidate`; browsers get `public, max-age=0, must-revalidate`. Every other HTML response, drafts included, is marked no-store for the CDN. Over `withISR`, the CDN is given only the freshness the page has left.
- Providers: `cloudflareZone`, `cloudflareWorkersCache` (refuses a host-routed app, since Workers Cache keys by path), `vercel` (`invalidateByTag` from `@vercel/functions`, or the REST API; invalidate by default) and `fastly` (soft purge by default). `defineCdnProvider` builds any other.
- Purges are coalesced for 250 ms, chunked to each provider's per-call limit, sent one call at a time, and retried on 429 or 5xx with capped backoff that honors `Retry-After`.
- `revalidateEndpoint({ cdn })` purges the origin store, then the CDN, and answers `200` when the CDN accepted, `202` when the purge is queued, and `502` with `retryable` when the CDN refused. It also takes a batch `{ "paths": [...], "tags": [...] }` of at most 100 paths and 32 tags. `createInvalidator` does the same from app code.
- `revalidateTags` may be a function of the route's params and URL, for tags per page. Invalid tags it returns are dropped with one `NIFRA_CDN_TAG_INVALID` warning per route.
- `isCacheablePage` is exported: the one rule ISR and the CDN cache by.
- New error codes: `NIFRA_CDN_HOST_ROUTED`, `NIFRA_CDN_TAG_INVALID`, `NIFRA_CDN_RATE_LIMITED`, `NIFRA_CDN_PURGE_FAILED`.
