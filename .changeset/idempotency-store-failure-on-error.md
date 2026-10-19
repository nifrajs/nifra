---
"@nifrajs/core": patch
---

A namespace resolver or store that fails on an idempotent route now reaches the app's `onError()` like a handler error, in every validation order, instead of rejecting `app.fetch()`. So does a response body that fails while the gate stores it.
