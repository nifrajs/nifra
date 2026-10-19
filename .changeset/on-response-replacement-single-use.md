---
"@nifrajs/core": patch
---

A Response an `onResponse` hook hands back in place of the one it was given, or an `onRequest` hook answers with, gets the single-use check a handler's result gets. One whose body already answered a request, or was handed over for one, now answers 500 without that request's cookies or headers, sync or async hook, on Web and Node-direct rendering alike. A hook returning a cached response could previously replay one user's session cookie to the next.
