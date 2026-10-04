---
"@nifrajs/agent": patch
---

`createMemoryAgentEvidenceLog()` evicts the oldest finished turn first when `maxTurns` is reached, and only evicts a running turn when none has finished. An evicted running turn now ends its rejoined `Last-Event-ID` replays (with no result) instead of leaving them waiting forever, since its later `finish()` can no longer reach it.
