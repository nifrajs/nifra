---
"@nifrajs/coding-agent": patch
---

On Windows under Bun, `BoundedSubagentRunner` refuses a subagent `cwd` or isolated worktree at a
drive root such as `"/"` or `D:\` when it lies outside the workspace `root`, and a `root` or
`allowedRoots` entry at a drive root covers that whole drive. A drive root was read as the current
directory on that drive.
