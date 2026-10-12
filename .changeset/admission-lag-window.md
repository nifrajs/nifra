---
"@nifrajs/middleware": patch
---

Loop-lag shedding in `createAdmissionController` now sheds every request that arrives while the event loop is lagging, not just one per sampler tick. `createEventLoopLagSampler` used to reset its window on every read, so the first request after a stall read the lag and every request after it, until the sampler's next tick, read 0 and was admitted (1 shed, 9 admitted after a 300 ms stall). A read with no new sample since the previous one now returns that previous window's value, for both the built-in timer-drift sampler and an injected histogram.
