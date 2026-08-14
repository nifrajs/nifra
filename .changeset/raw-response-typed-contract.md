---
"@nifrajs/core": minor
"@nifrajs/client": patch
---

New `raw<T>(response)` escape hatch keeps a hand-built `Response` inside the typed contract. A route
that returns a bare `Response` - a Server-Sent Events stream, a file download, a signed token payload -
previously inferred `res.data: never` on the client. Wrap the return as `raw<T>(response)` and the
client sees `res.data` as `Jsonify<T>` while the route still ships the exact `Response` at runtime.
Branded binary responses from `bytes()` keep their `Blob` typing; only an unbranded `Response` return
falls back to `never`.
