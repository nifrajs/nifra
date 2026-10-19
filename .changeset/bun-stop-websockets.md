---
"@nifrajs/core": patch
---

On Bun, `app.stop()` now sends every open WebSocket a 1001 "server shutting down" close and gives it the drain window to finish, before `onStop` hooks run, as the Node adapter does. Previously the sockets stayed open after `stop()` resolved, `onStop` hooks ran while their handlers could still fire, and a connected client kept the process alive. `stop()` also removes the SIGTERM and SIGINT handlers that `gracefulSignals` installed, so repeated `listen()`/`stop()` cycles no longer accumulate them.
