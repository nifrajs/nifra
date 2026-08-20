---
"@nifrajs/agent": minor
"@nifrajs/ag-ui": minor
---

Resumable SSE evidence streams.

`@nifrajs/agent/events` gains the `AgentEvidenceLog` seam and its in-memory reference
(`createMemoryAgentEvidenceLog`): per-turn step evidence is recorded, replayable after a `seq`
cursor, and live-subscribable while the turn runs.

With an `evidenceLog` configured, `mountAgent` and `mountAgUI` stamp evidence frames with SSE
`id: <seq>` and serve reconnects: a re-POST of the same turn with a `Last-Event-ID` header replays
the missed evidence and rejoins a still-running turn live, or replays the stored terminal frame -
the run is never re-executed. Malformed cursors are rejected with 400, unknown turns with 409.
