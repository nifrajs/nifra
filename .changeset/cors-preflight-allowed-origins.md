---
"@nifrajs/middleware": patch
---

A preflight from an origin the policy does not allow now gets a bare `204` without `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` or `Access-Control-Max-Age`, and requested header names are reflected only when each is a valid header token. A predicate `origin` runs for the preflight and again when the response headers are added.
