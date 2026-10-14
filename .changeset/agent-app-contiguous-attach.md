---
"@nifrajs/agent-app": patch
---

`AgentAppClient.send` re-attaches a broken turn from the last seq it delivered in order instead of the highest seq it received. An event that arrived ahead of a gap moved the cursor past the gap, so the attach skipped the missing event for good; events replayed twice are dropped by the ordering buffer.
