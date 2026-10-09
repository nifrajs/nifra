---
"@nifrajs/core": patch
---

A route whose result cannot be rendered (a `BigInt` in the JSON, a header value with a line break) is now logged and answered `500` on every lane, with `onResponseFinalized` and the app's response headers applied. The fast lanes a route without `onError` takes threw instead: `app.fetch` threw synchronously or rejected, `onResponseFinalized` never ran, and on `listen()` the 500 lacked the headers `responseHeaders()` and `onResponse` add. On the Node-direct lane the request failed instead of answering.
