---
"@nifrajs/node": patch
---

A JSON request body on Node parses as its read settles, and an asynchronous response clears its in-flight count with one promise step instead of three. On the HTTP benchmark's `POST /users` route (body schema) that is about 3% more requests per second; an aborted upload still rejects its read through the request's `close` and `error` events.
