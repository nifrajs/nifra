---
"@nifrajs/core": minor
---

One `resume` or `compensate` call owns a saga at a time. It claims the saga with a lease that every transition renews (`createSagaEngine({ leaseMs })`, default 5 minutes) and releases it when it returns or throws. A second call while the lease is live throws `SagaConcurrencyError` and changes nothing; a call that died is taken over once its lease lapses, and a step it left executing goes to manual review as before. A call that loses a write to another one stops without compensating, and a step whose record is gone is never written back. `SagaRecord` gains the optional `owner` and `leaseUntil` fields; stored records without them load unchanged.
