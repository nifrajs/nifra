---
"@nifrajs/core": patch
---

A merged group's request hooks now run for an `OPTIONS` request to a path the group serves. A group's hooks were scoped to the method and path of its routes, so a CORS preflight to a merged `POST /items` never reached the group's `cors()` and was answered `405`.
