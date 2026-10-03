---
"@nifrajs/core": patch
---

`listen()` answers a request whose app-wide `onRequest`/`onResponse` hook throws with the same JSON `500 internal_error` a throwing route gets, and logs it through the app's logger. Bun's development error page, which shows the message, stack and source whenever `NODE_ENV` is not `production`, is no longer served.
