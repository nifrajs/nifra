---
"@nifrajs/agent": minor
---

`createMemoryAgentEvidenceLog` bounds the evidence it keeps for one turn, across every resume of it, with the new `maxEvidencePerTurn` option (default 1024). `maxTurns` bounded how many turns were kept but not what each held, so a turn id that was run or resumed again and again kept every evidence item it ever recorded. Past the bound the oldest items are dropped, and a replay from a `Last-Event-ID` older than the items still held gets `undefined` - the mounted agent route answers `409 { error: "replay_unavailable" }` - instead of a stream with a silent gap.
