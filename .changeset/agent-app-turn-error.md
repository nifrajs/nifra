---
"@nifrajs/agent-app": patch
---

A turn the host ends with its terminal `event: error` frame now rejects `AgentAppClient.send()` (and `HttpAgentTransport.stream()`) with the new `AgentTurnError`, instead of completing as if the turn had succeeded. The error carries the host's short failure `code` (`turn_failed` unless the frame names a well-formed one) and none of the host's diagnostic text, and it is never retried by attaching again: the work failed, not the connection.
