---
"@nifrajs/testing": minor
---

`captureIncident` keeps every query pair in order as `request.queryPairs` when the `query` object cannot rebuild it, such as a repeated name, and keeps a non-JSON request body as its text with `request.bodyEncoding: "text"`. `replayIncident` sends both back exactly as captured, so a request with `?q=a&q=b` or a `text/plain` body reproduces. `generateRegressionTest` redacts the values in `queryPairs` like those in `query`.
