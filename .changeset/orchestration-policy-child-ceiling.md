---
"@nifrajs/coding-agent": minor
---

`OrchestrationHost`'s `policy.allowedCapabilities` now bounds every catalog step a submitted plan
resolves to, under any narrower `limits.allowedCapabilities`. `limits.maxChildren` counts every
subagent a run starts, retries included, and a plan with more subagent nodes than the ceiling
(default 4) fails to compile with `E_MAX_CHILDREN`. `SubagentRunnerOptions.children` shares one count
among several runners.
