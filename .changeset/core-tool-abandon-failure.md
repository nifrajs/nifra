---
"@nifrajs/core": patch
---

`executeTool` resolves with the call's own result when the idempotency store's `abandon()` throws. A store that failed while releasing a reservation (after a budget refusal, a cancellation, a dry run or an executor that threw) used to make `executeTool` reject with the store's error instead. The key then stays reserved until its lease lapses.
