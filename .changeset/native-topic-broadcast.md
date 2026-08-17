---
"@nifrajs/core": patch
---

On Bun, `app.publish(topic, data)` now fans out through the runtime's native topic broadcast when no WebSocket route validates its outbound frames, so a broadcast reaches every subscriber without a per-connection loop. A route with `validateSend: true` keeps the portable per-socket path, since its frames are validated (and dropped when invalid) individually; other runtimes are unchanged.
