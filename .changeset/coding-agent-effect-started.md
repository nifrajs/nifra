---
"@nifrajs/coding-agent": minor
---

`RunRecoveryMachine` records an `effect-started` checkpoint before it invokes an effect. A dispatch redelivered after its worker was lost mid-effect is dead-lettered with `idempotency_required` unless its idempotency proof exists; it is no longer run again. `DispatchBoundary` gains `"effect-started"`, so a custom `RunDispatchStore` must accept it. An effect that calls `checkpoint("before-effect")` still declares that a redelivery may rerun it.
