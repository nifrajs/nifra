---
"@nifrajs/core": patch
---

After an async `authenticate` stage, a `derive` or handler that throws synchronously now reaches `onError`. The rest of the route ran inside the stage's promise callback, so the throw rejected the request instead. `app.fetch` rejected, `toFetchHandler` rejected, and `Bun.serve` answered its own 500 without calling `onError` or the logger.
