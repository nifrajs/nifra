---
"@nifrajs/coding-agent": patch
---

`CodingAgentHost.start` refuses a second start while one is in flight, and `stop()` during startup waits for it and closes the session it created, so neither leaves a live backend session behind. Concurrent RPC `session.create` and `session.resume` requests share one start and return the same session.
