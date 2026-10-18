---
"@nifrajs/coding-agent": patch
---

`ApprovalManager.request()`, `offer()` and `observe()` no longer wait on an `onRequired` hook that has not settled once the approval itself is decided. A broadcast that never finished kept the caller waiting after the approval had already timed out, been answered or been closed; the caller now gets the decision as soon as the approval settles.
