---
"@nifrajs/coding-agent": minor
---

`BoundedSubagentRunner` reports an executor that keeps running after its run timed out or was cancelled. `onAbandoned` receives the spec, the reason, the cwd it was given, and a `settled` promise; the runner's `abandoned` count holds it until it settles; and `maxAbandoned` refuses new children while that many still run. Runners that share an `abandonment` ledger are counted together. An executor that honours its abort signal is not reported. The orchestration host counts across all its runs, with `onSubagentAbandoned(runId, nodeId, abandonment)`, `abandonedSubagents`, and `limits.maxAbandonedSubagents`.
