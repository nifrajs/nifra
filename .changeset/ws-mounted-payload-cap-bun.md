---
"@nifrajs/core": patch
---

On Bun, a mounted app's `wsMaxPayloadBytes` now holds for its own sockets. Before, `listen()` applied only the parent's cap: a child that declared 16 bytes still received a 5000-byte message, and a child that declared more than the parent had its messages cut off at the parent's cap. The listener's frame limit is now the largest cap among the parent and its mounted apps, and a socket whose app declares less closes with `1009` when a message exceeds it.
