---
"@nifrajs/jobs": patch
---

A worker started with `start()` keeps polling when the store's `lease` throws: the failure goes to the new `onPollError` option (default `console.error`) instead of becoming an unhandled rejection, and `stop()` resolves even if the last round failed.
