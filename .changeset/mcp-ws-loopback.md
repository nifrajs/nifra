---
"@nifrajs/cli": patch
---

The `nifra_ws` MCP tool starts the project's backend on 127.0.0.1 for its WebSocket check. It listened on every interface, so the app, with its environment loaded, was reachable from the network while the check ran.
