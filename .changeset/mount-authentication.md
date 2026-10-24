---
"@nifrajs/core": minor
"@nifrajs/middleware": patch
---

An `authenticate()` stage now gates the `mount()` and `mountFetch()` handlers registered after it, as it gates the routes declared after it. So do the required auth plugins built on one: `bearer()`, `jwt()`, `basicAuth()` and `apiKey()`. Before, `server().use(bearer(...)).mountFetch("/legacy", handler)` served `/legacy/*` to any caller, for every method, while the routes beside it answered 401. A request a stage refuses gets the stage's response and never reaches the mounted handler or child app, its WebSocket upgrades included; a stage that throws answers 503 `auth_unavailable` and logs the cause. A mount registered before the stage stays public, so mount first when the legacy app keeps its own auth.
