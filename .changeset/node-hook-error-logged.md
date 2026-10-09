---
"@nifrajs/node": patch
"@nifrajs/core": patch
---

On Node, a hook that throws past `app.fetch` (an `onRequest` hook that reads `new Request(req)`, a mount handler that throws) used to answer `500` with nothing logged anywhere. The error now goes through the app's own `logger`, as Bun's `listen()` logs it, and the README says to copy a hook's request with `req.clone()`.
