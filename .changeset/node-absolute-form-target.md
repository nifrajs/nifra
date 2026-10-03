---
"@nifrajs/node": patch
---

A request whose target is in absolute form (`GET http://host/path`) is routed as `/path` with its Host header, as Bun and Deno route it. Hooks and the router used to see the full URL appended to the origin.
