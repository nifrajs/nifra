---
"@nifrajs/core": minor
"@nifrajs/schema": minor
---

feat(core): `bodyParser(schema, { types, parse })` from `@nifrajs/core/body-parser` lets one route
read a request body in a media type other than JSON, urlencoded, or multipart. `parse` is handed the
body's bytes and what it returns is validated by `schema`, so the handler sees the same typed body
whatever format it arrived in. JSON and urlencoded bodies still reach the schema through their own
lanes, and a route that does not opt in still answers `415`.

```ts
import { bodyParser } from "@nifrajs/core/body-parser"
import { parse } from "yaml"

const utf8 = new TextDecoder("utf-8", { fatal: true })

app.post(
  "/pipelines",
  {
    body: bodyParser(Pipeline, {
      types: ["application/yaml"],
      parse: (bytes) => parse(utf8.decode(bytes), { maxAliasCount: 0 }),
    }),
  },
  (c) => c.body.name,
)
```

- The request's media type is matched in full against `types`: case folded, parameters set aside.
  `parse` also receives `{ mediaType, contentType }`.
- The body is read under the route's `bodyLimit` before `parse` runs: `413 payload_too_large` over
  it, `400 invalid_content_length` for a length that is not one.
- A `parse` that throws or rejects answers `400 invalid_body`.
- The decoded value must be a tree. An object, array, `Map` or `Set` reached twice, which is what an
  alias or a cycle decodes to, answers `400 invalid_body` under every `protoPoisoning` setting.
- `protoPoisoning` applies to the decoded value: a `__proto__` key, a `constructor` that carries a
  `prototype`, and a plain object whose prototype the decoder replaced are rejected or stripped.
  Instances of a class, such as a `Date` or a `Uint8Array`, pass through as they are.
- `types` takes full `type/subtype` names and throws a `TypeError` for JSON, urlencoded, multipart,
  and `text/plain`. The first three already have readers; `text/plain` is sent by a browser from any
  site without a preflight.
- A decoder's own limits (nesting depth, alias expansion) are not covered: configure the decoder you
  pass for untrusted input.

`bodyParser` and `multipartBody` compose in either order, and two `bodyParser` wraps each read their
own types; the outer one wins a type both name. `multipartBody` now hands a body that is not
multipart to a reader the schema already carried instead of answering `415` itself.

feat(schema): `toOpenAPI` and `toOpenAPIFromEvidence` list each media type a `bodyParser` schema
reads as its own entry under the operation's `requestBody.content`, in a fixed order, next to the
JSON or multipart entry. `reflectSchema` reports them as `mediaTypes`, and a project evidence
snapshot carries them, so a document built from a stored snapshot matches the live one.
