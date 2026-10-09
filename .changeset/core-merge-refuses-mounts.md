---
"@nifrajs/core": patch
---

`merge()` refuses a server that holds `mount()`s or `mountFetch()`es, as it already refused one with WebSocket routes, with a `RouteConfigError` that says to add them on the parent. It used to fold in the server's routes and drop its mounts without a word, so every request under a mount prefix answered `404`.
