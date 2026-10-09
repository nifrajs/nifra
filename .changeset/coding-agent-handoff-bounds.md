---
"@nifrajs/coding-agent": minor
---

`HandoffCoordinator` now expires overdue boundaries when it opens, lists or inspects them, so a pending handoff nobody decided no longer holds a `maxPending` slot past its deadline. Settled boundaries are kept up to a new `maxRetained` option (default 256) and evicted oldest first.
