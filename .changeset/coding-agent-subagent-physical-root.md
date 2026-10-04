---
"@nifrajs/coding-agent": patch
---

`BoundedSubagentRunner` checks a subagent's working directory against the workspace `root` and `allowedRoots` by physical path. A symlink inside the root that points outside it is refused like any other path outside the root, whether it comes from `spec.cwd` or from an `isolatedWorktree` lease. A directory that does not exist yet is checked through its nearest existing parent. On Windows, a working directory on another drive is refused.
