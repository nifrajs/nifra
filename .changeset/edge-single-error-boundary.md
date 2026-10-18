---
"@nifrajs/edge": patch
---

A route on the compact edge server answers the same flat `500 {"ok":false,"error":"internal_error"}` as the full server when its body schema's `validate` throws or rejects, or when the value a handler returns cannot be serialized (a `BigInt`, a circular object, a throwing `toJSON`). Those failures used to reject `fetch()` with the original error instead. A `Response` thrown by a handler, or now by a validator, is still returned as the answer.
