---
"@nifrajs/cache": patch
---

A `delete`, `invalidateTag`, `clear` or `set` now stops a `wrap` load or stale-while-revalidate refresh already running for that key or tag from storing its result. Before, a refresh that started before `invalidateTag` wrote the old value back for a new TTL. The next `wrap` after the invalidation runs its own load instead of joining the withdrawn one.
