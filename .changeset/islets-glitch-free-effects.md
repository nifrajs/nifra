---
"@nifrajs/islets": patch
---

Effects no longer see a `computed` that lags its inputs, and each runs once per write. An effect reading both a signal and a `computed` of it used to run with the new signal value and the old derived value, then again once the `computed` caught up, batched or not. A write now recomputes the computeds it feeds first, then runs each affected effect once; a write an effect makes during that flush queues instead of nesting, and a `computed` read inside `batch` is already current. The full-feature island bundle stays at 2,080 B gzipped.
