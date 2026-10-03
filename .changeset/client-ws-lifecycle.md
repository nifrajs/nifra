---
"@nifrajs/client": patch
---

The `.ws()` handle behaves correctly around a closed socket. `messages()` called after the socket closed, or with an already-aborted signal, ends at once instead of waiting forever. `send()` on a closing or closed socket drops the frame, as `WebSocket.send` does, instead of queueing it with nothing left to flush it, and frames queued before a failed connect are released. Ended iterations and closed sockets no longer leave listeners on the signals they were given. `ClientOptions.headers` now documents that a WebSocket handshake never carries them, on any runtime.
