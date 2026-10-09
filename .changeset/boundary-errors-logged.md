---
"@nifrajs/web": patch
"@nifrajs/core": patch
---

A loader, action or render failure that an `_error` page answers is written to the server's `logger` as `unhandled request error`, with the request line and the detail `errorLogDetail` allows, the same entry an error with no boundary gets. A soft-navigation data request that a boundary answers with a 500 is logged the same way. Control flow such as a thrown `redirect()` is not logged. `@nifrajs/core/edge-kit` exports `emitRequestErrorLog` and `ErrorLogDetail`, the function the server itself logs through.
