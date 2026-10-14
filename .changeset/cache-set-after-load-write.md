---
"@nifrajs/cache": patch
---

`cache.set` now waits for a `wrap` load's store write already sent for the same key, as `delete`, `invalidateTag` and `clear` do. Withdrawal only stopped a load that had not yet written, so with an async store that applies requests out of order an older loaded value could land after, and overwrite, a newer `set`.
