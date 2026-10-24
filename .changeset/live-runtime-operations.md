---
"@nifrajs/web": minor
---

The live runtime is easier to operate:

- `live.status()` reports whether the runtime is ready, whether the bus is down and since when, open
  sockets, live loads, bus events applied, sockets notified, and the last publish lag; `live.close()` ends every socket with `1001` and stops reading the bus.
  Call it in `onStop` before closing your Redis clients.
- A `logger` option (default `jsonLogger()`) logs the bus going down and coming back, events lost
  before this process read them, and publishes not read back.
- `redisLiveBus()` takes `read` as optional: a process that only publishes passes `send` alone, and
  `livePublisher(bus)` gives it a validated `publish(...keys)`. Subscribing without `read` throws.
- A server-rendered page now carries a short-lived seed grant, so the page no longer runs its loaders
  a second time when its live socket opens: the socket exchanges the seed for a grant bound to it,
  re-checking gates. Pages under partial prerendering, server-component routes and Workers hub mode
  keep the full first load.

A page polling while its socket is down now reloads all its data on every poll; before, every poll
after the first kept stale owners and never refreshed them.
