---
"@nifrajs/core": patch
---

A saga store refuses a `compareAndSet` whose `record.sagaId` differs from the `sagaId` it is written under, on `MemorySagaStore` and every durable execution adapter. `runDurableExecutionAdapterConformance` now checks that an adapter refuses it.
