---
"@nifrajs/agent-protocol": patch
---

`createAgentEventStream` now drops the oldest `assistant.delta` or `tool.delta` when a slow consumer fills the queue, and drops a lifecycle event such as `tool.started` only once no delta is left. A host that records session evidence from a backend's live stream keeps its tool and turn events.
