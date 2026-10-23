---
"@nifrajs/web": patch
---

A `defer()` value that rejects is written to the app's server log, under its `errorLogDetail`, on the
streamed document and on a client navigation's data request. It went to `console.error` with its
stack, past a `logger` the app had set, the same as a failure an `_error` page answers.
