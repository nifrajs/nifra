---
"@nifrajs/core": patch
---

The in-memory durable stores (`MemoryDurableEffectStore`, `MemoryApprovalStore`, `MemorySagaStore`) no longer perform a redundant deep clone when persisting a state transition. Stored records are already fresh and frozen, and reads still hand back isolated copies, so behaviour is unchanged while each transition allocates less.
