---
"@nifrajs/islets": minor
---

`computed(fn)` returns a `Computed<T>` reader with `.dispose()`, which unsubscribes it from its inputs so a dropped computed no longer recomputes on every write. A malformed `data-island-state` attribute is reported with the same console message as one that is not a JSON object.
