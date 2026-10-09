---
"@nifrajs/core": patch
---

`executeTool` no longer releases a tool's idempotency key once its executor has run. A store that throws while completing the call is now treated as one that refused it (`idempotency_capacity`), and an output validator that throws keeps the key reserved, so a retry cannot repeat a side effect that may have committed.
