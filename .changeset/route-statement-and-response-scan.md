---
"@nifrajs/cli": minor
---

`nifra check` reports NF-C045, a warning, for a route added to a server as a statement of its own (`app.get("/x", h)` with its result unused) when that server is exported or read by `typeof`. The route is served, but `typeof app`, which the typed client reads, never includes it. `// nifra-expect NF-C045: <reason>` above the statement accepts a route kept off the type on purpose.

The raw-`Response` advisory (NF-C007) and the static route scan read routes chained onto `createWebApp(...)` as well as `server(...)`. NF-C007 also counts a `Response` held in a local before it is returned, a handler's `c.json()` or `c.text()`, and a call to a function imported from a relative module that returns one, reported at each route that returns it.
