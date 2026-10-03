---
"@nifrajs/node": patch
---

A `HEAD` request to a route that streams its body cancels that body once the headers are sent, as on Bun and Deno, so the route's producer stops instead of running with no reader.
