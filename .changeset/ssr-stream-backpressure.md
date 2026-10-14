---
"@nifrajs/web": patch
---

A streamed page now renders only as fast as the client reads it. The document stream read the whole app stream up front, so a client that stopped reading left the full rendered body queued in memory; it now pulls one renderer chunk per read. The Vite dev bridge (`pipeWebBodyToNode`) likewise waits for `drain` when the socket buffer is full instead of writing every chunk at once, and removes its listeners when the body ends.
