---
"@nifrajs/core": minor
"@nifrajs/schema": minor
"@nifrajs/client": minor
"@nifrajs/edge": patch
"@nifrajs/node": patch
"@nifrajs/cli": patch
"@nifrajs/mock": patch
---

A `bigint` in a JSON answer is written as its decimal string, `{ "id": "9007199254740993" }`, on every
runtime and lane: a returned value, `status(...)`, `c.json(...)`, an SSE event, the plain transport
codec and `@nifrajs/edge`. A route returning one used to answer a 500. The typed client reads such a
field as `string` (it was typed as absent), and `nifra openapi` describes it as a string of digits.

`t.bytes()` declares a response field filled with a `Uint8Array` or a `Buffer`. A route whose
`response` or `errors` declares one writes every `Uint8Array` in its answer as base64, the typed client
reads a `string`, the document says `{ type: "string", contentEncoding: "base64" }`, and a mock fills
it with valid base64. A request or `sse` schema that declares it is refused at registration with
`RouteConfigError` `RESPONSE_ONLY_SCHEMA`. The step is `withBase64Bytes` from `@nifrajs/core/binary`,
for a hand-written schema too. A `Uint8Array` on a route without the field is still the
`{ "0": 1, ... }` object `JSON.stringify` writes, and the client and `nifra openapi` now describe it as
that object.
