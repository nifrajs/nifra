---
"@nifrajs/core": minor
"@nifrajs/schema": minor
"@nifrajs/testing": patch
---

A closed request-header schema (`headers: t.object({...})`) validates only the header names it declares, each read case-insensitively and keyed as declared. Every client sends headers a route never declares (`host`, `user-agent`, `accept`), so such a schema used to answer every over-the-wire request with a 422; it now matches the OpenAPI document, which lists one `in: header` parameter per declared name. Open schemas, and schemas that do not expose their JSON Schema, still receive every header. `declaredHeaderNames` is exported from `@nifrajs/core/reflection`.

`t.headers({...})` is the open header-slot schema: every header arrives with its name lower-cased, and declared `t.integer()` / `t.number()` / `t.boolean()` fields are coerced from text. It refuses an upper-case name.

`runAdversarialContract` sends the headers real clients send (`accept`, `accept-encoding`, `accept-language`, `user-agent`), validates a header witness the way the route's slot does, and names the refused fields when a witness is rejected or a valid witness is answered with a validation 422.
