---
"@nifrajs/agent-app": minor
---

`AgentAppClient.send()` streams a turn on a session other clients share. A turn's events used to wait behind the seqs that went to another tab's turns, a gap that never fills, so that tab saw no events at all. A turn now starts at its first event, and anything still held behind a gap is released, in order, when the stream ends. `OrderedEventBuffer` gains `flush()` for the same purpose: it releases every held event and counts the missing seqs on `dropped`.
