---
"@nifrajs/coding-agent": patch
---

A subagent's `timeoutMs` and cancellation now cover acquiring its isolated worktree: the run settles at the deadline even while `isolatedWorktree` is still pending, and a lease that arrives later is cleaned up without starting work in it.
