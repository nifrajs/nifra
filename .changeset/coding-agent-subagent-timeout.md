---
"@nifrajs/coding-agent": patch
---

A subagent's `timeoutMs` now ends `BoundedSubagentRunner.run()` even when the executor ignores the abort signal: the result is `{ ok: false, error: "subagent timed out" }` (or `"subagent cancelled"` when the runner's `signal` aborts), and the workspace lease is cleaned up. A runner whose `signal` is already aborted no longer starts the executor.
