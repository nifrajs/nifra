---
"@nifrajs/coding-agent": minor
---

`CodingAgentRpcServer` takes `resumableTurns`, so a desktop or mobile client that drops its connection no longer loses the turn. Each `turn.send` SSE frame now carries `id: <seq>`. With `resumableTurns: true`, the turn runs on the server whether or not a client is reading; `turn.attach` with `{ afterSeq }` or a `Last-Event-ID` header replays the frames after that seq and follows the rest. The newest `replayEvents` frames (default 1024), up to `replayBytes` (default 8 MiB), are held; an older cursor answers `409 resync_required`, a second `turn.send` while one runs answers `409 turn_running`, and a turn no client has followed for `detachedTimeoutMs` (default 2 minutes) is cancelled. Without the option a disconnect still cancels the turn and `turn.attach` answers `501 feature_unsupported`. The server also passes `extensionEvents` through to its host.
