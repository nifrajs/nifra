---
"@nifrajs/coding-agent": patch
---

`BoundedSubagentRunner` releases a workspace lease only after its executor settles. A run that times out or is cancelled still returns at once, and its lease's `cleanup` runs when the executor finishes, so an executor that ignores the signal keeps its `cwd` until it stops. A run whose signal is already aborted no longer asks `isolatedWorktree` for a lease.
