---
"@nifrajs/core": patch
---

A request `transportCodecs()` decodes keeps the body and `Content-Type` it was sent with. A route without a body schema, or middleware such as a signature check, used to read a `{}` JSON stand-in from `c.req.text()` or `c.req.json()`; it now reads the payload itself, while a route with a body schema still receives the decoded value as `c.body`.
