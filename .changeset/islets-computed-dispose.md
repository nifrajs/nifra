---
"@nifrajs/islets": minor
---

`computed(fn)` runs `fn` on first read instead of at creation, and stops by itself once nothing reads it: the next change to its inputs unsubscribes it instead of recomputing, so a dropped computed no longer recomputes on every write. Reading it again computes it afresh. It returns a `Computed<T>` reader whose `.dispose()` stops it at once. A malformed `data-island-state` attribute is reported with the same console message as one that is not a JSON object.
