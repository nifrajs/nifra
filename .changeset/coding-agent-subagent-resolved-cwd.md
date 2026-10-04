---
"@nifrajs/coding-agent": patch
---

Under a workspace policy, `BoundedSubagentRunner` hands its executor the `cwd` it checked with that path's symlinks already resolved, instead of the path as written. Re-pointing a link after the check no longer changes where the executor runs.
