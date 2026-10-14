---
"@nifrajs/core": patch
---

`ws.subscribe(topic)` on a closing or closed socket is now a no-op. Close drops a connection's topics, so an async handler that subscribed after the close (an `open` or `message` resuming late) left the dead socket in the in-process registry for good, where every `app.publish` kept sending to it.
