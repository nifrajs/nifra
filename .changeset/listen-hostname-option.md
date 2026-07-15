---
"@nifrajs/core": minor
---

`app.listen(port, { hostname })` selects the bind address. It defaults to every interface, as before;
pass `"127.0.0.1"` to bind loopback only for an admin surface, a sidecar, or any app that must not be
reachable off the box.
