---
"@nifrajs/cli": patch
---

NF-C054 no longer reports a call with a path and no handler as a route, such as `headers.get("if-none-match")`, `url.searchParams.get("id")` or `map.get("/")` in a file that creates the server.
