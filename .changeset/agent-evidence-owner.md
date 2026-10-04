---
"@nifrajs/agent": minor
"@nifrajs/ag-ui": minor
---

Resumable agent streams can be scoped to the caller:

- New `evidenceOwner` option on `mountAgent` and `mountAgUI`. It returns the caller's user or tenant id, and turns are recorded and replayed under it. Another caller's `Last-Event-ID` reconnect or reused turn id finds none of that caller's turns. It runs before any replay is served, and throwing from it refuses the request.
- New `scopeAgentEvidenceLog(log, owner)` in `@nifrajs/agent/events` returns the per-owner view of an `AgentEvidenceLog` that the seams use.
- `mountAgent` answers `400 { error: "invalid_turn_id" }` for a `turnId` that is not a bounded token before it reads the evidence log, matching `mountAgUI`.
