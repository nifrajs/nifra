---
"@nifrajs/core": patch
---

A request body or WebSocket frame decoded by a transport codec must be a tree. A value containing a cycle is answered as an invalid payload, and shared references may add at most 100,000 nodes to the tree they expand to. The `protoPoisoning` policy also applies to the members of a decoded `Map` or `Set`.
