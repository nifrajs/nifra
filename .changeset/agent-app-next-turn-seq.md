---
"@nifrajs/agent-app": patch
---

`AgentAppClient.send()` delivers every turn, not only the first. The client advances `session.lastSeq` as it yields each event, and the next turn's ordering buffer starts after it. Previously a second turn's events waited behind a gap that never filled, and the turn yielded nothing.
