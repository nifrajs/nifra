---
"@nifrajs/agent": minor
"@nifrajs/mcp": minor
"@nifrajs/coding-agent": patch
---

Event streams stay bounded for a client that stops reading. `mountAgent` takes `maxOutputBytes` (default 4 MiB): past it an SSE response ends with an `output_limit` error frame, and with an `evidenceLog` a `Last-Event-ID` reconnect reads on. `respondMcpHttp` and `createMcpServer` take `maxPendingBytes` (default 4 MiB): an SSE stream with more than that waiting for its client is dropped and its tool call cancelled. The coding agent's `turn.send` stream advances the backend only as the client reads, and a resumable follower that falls `replayBytes` behind is dropped and can attach again from its cursor.
