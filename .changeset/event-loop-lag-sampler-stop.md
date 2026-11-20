---
"@nifrajs/middleware": patch
---

`createEventLoopLagSampler` returns a sampler with `stop()` and `[Symbol.dispose]()` that end its timer.
