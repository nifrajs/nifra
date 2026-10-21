---
"@nifrajs/node": patch
---

A WebSocket publish on Node frames each text once and writes that frame straight to every idle subscriber's socket, about a quarter less time per publish at 2,000 subscribers. A socket still sending, compressing or closing takes the usual send path, so order holds.
