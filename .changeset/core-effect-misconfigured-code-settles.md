---
"@nifrajs/core": patch
---

An owned effect whose `errorCode` or `failurePhase` mapper throws or returns an invalid value is still settled when it fails. The validation error used to be thrown before the `failed` transition and the lifecycle event, so the durable record stayed unfinished until reconciliation found it. The effect now settles with the default code and phase, and the validation error is thrown after.
