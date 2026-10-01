---
"@nifrajs/web": minor
---

feat(web)!: `withISR` no longer caches a page per query string by default.
The default key was `origin + pathname + search`, so `?a=1`, `?a=2`, ... each stored a full page and
anyone could grow the cache without bound. The new `query` option decides how a query string reaches
the default key:

- `"bypass"` (default): a request carrying any query parameter skips the cache. It is rendered fresh
  and never stored. A request without one is keyed on `origin + pathname`.
- `["page", "sort"]`: those parameters join the key in any order (`?sort=new&page=2` and
  `?page=2&sort=new` share an entry). A request carrying any other parameter skips the cache, so a
  loader that reads it is never handed another request's page.
- `"all"`: the previous behavior, one entry per distinct query string.

`revalidateEndpoint` takes the same `query` option so a purged path's query is keyed the way it was
stored. A purge of a query string the policy never caches returns `400` with `uncached_query`. A
custom `key` on either still overrides the policy.

Migration: pass `query: "all"` to both `withISR` and `revalidateEndpoint` to keep the old keys.
