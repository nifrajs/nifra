---
"@nifrajs/testing": patch
---

`e2eUrl` and `e2eWebSocket` refuse a path that does not stay on the test app's origin with one error, "must be a same-origin absolute path", whichever check catches it.
