---
"@nifrajs/node": patch
---

`HEAD` requests now return an empty body while still advertising the `Content-Length` a matching `GET` would produce, per the HTTP spec. Previously a response body was written on `HEAD`.
