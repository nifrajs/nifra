---
"@nifrajs/core": patch
---

On Bun's `listen()`, a raw `#` in the request target no longer picks a route the parsed URL does not. Bun's native route table read `#` and everything after it as path, so `GET /admin/..#/users/42/delete` ran a `/admin/:org/users/:userId/delete` handler while `c.req.url` and `app.fetch` saw `/`, and a guard that checks the URL path let it through. A param holding `#` now goes to the portable router, which routes the path the URL ends with (`/` here), as Node, Deno and `app.fetch` already did. A sent `%23` routes as before.
