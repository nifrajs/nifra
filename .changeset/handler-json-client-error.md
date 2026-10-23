---
"@nifrajs/core": patch
---

A request body that a handler's own `c.req.json()` cannot parse, and that the app lets escape, answers
400 `invalid_json` instead of a logged 500. The read still rejects with the `SyntaxError`
`Request.json()` rejects with, so app code and `onError` hooks that catch it are unchanged. A
`SyntaxError` the app raises on its own data stays a 500. A route with `bodyLimit: "unlimited"` reads
through the runtime's own `json()` and keeps its 500.
