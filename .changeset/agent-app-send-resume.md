---
"@nifrajs/agent-app": minor
---

`AgentAppClient.send` resumes a turn whose stream breaks mid-turn: it calls `turn.attach` with the last seq it received and goes on yielding views without a gap or a repeat. `resumeAttempts` (default 3, counted since the last attach that delivered a new event; 0 turns it off) and `resumeDelayMs` (default 250) bound it. A host that refuses the attach (it keeps no turns, or no longer holds those events) leaves `send` throwing the original break, as before. `AgentTransportError` now carries the response `status` when a host refused a stream.
