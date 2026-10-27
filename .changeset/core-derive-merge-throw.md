---
"@nifrajs/core": patch
---

A `derive` result that cannot be merged into the request context, such as one naming a read-only key like `env` or one whose getter throws, is answered with the logged `500 internal_error` on every route, as a throwing `derive` is. A throw raised after a JSON body is read is never answered `400 invalid_json`.
