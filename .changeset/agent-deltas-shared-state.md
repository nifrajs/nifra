---
"@nifrajs/agent": minor
---

Model-port streaming and a shared UI state channel. `ports.deltas` (an `AgentDeltaSink`) puts an optional `onDelta` callback on every model request; a streaming port calls it per chunk - text, reasoning, or tool-call argument text. Deltas are transient observer data: never validated, persisted, or replayed, and a failing sink never fails the model step. `combineAgentDeltaSinks` fans deltas out like `combineAgentTelemetry` fans evidence. `createAgentSharedState(initial)` adds a per-run JSON document patched with RFC 6902 operations (`add`/`replace`/`remove`, atomic per batch, prototype-grafting pointer segments refused) and observed via `subscribe`.
