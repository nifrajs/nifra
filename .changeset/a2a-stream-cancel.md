---
"@nifrajs/a2a": patch
---

A client that disconnects from a `SendStreamingMessage` stream now aborts the agent run's signal, so model and tool calls that honour it stop instead of running to the end for nobody. A signal passed through `ports` is still honoured alongside it.
