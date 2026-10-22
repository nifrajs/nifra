---
"@nifrajs/core": patch
---

A request body that fails while it is read - a client that hung up inside it, which Deno hands an app
- is refused 400 `invalid_body` by the urlencoded form lane, multipart, custom body parsers,
`c.boundedBody()` and the handler's own `c.req.text()` / `c.req.bytes()`, and 400 `invalid_json` by the
JSON lane. These answered 500. Only a body a runtime took off a client's connection is refused this way:
a body built in the app's own process keeps its producer's error. `verifyWebhook` reports such a body
with the new reason `"invalid_body"`.
