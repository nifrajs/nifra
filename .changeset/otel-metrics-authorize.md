---
"@nifrajs/otel": minor
---

`metrics()` takes an `authorize(req)` option that gates the scrape endpoint; a refused scrape answers 401 with an empty body. Without it the endpoint stays public, which the option's documentation now states.
