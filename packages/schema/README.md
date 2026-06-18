# @nifrajs/schema

The optional, batteries-included schema builder for [nifra](../../README.md): `t` is
TypeBox-backed, so it **validates** at the boundary *and* gives you **OpenAPI for
free** (a TypeBox schema is a JSON Schema). Plus `toOpenAPI(contract | app)`.

```sh
bun add @nifrajs/schema
```

```ts
import { server } from "@nifrajs/core"
import { t, toOpenAPI } from "@nifrajs/schema"

const app = server().post("/users", { body: t.object({ name: t.string(), age: t.integer() }) }, (c) => ({
  id: "u1",
  name: c.body.name, // typed + validated
}))

const openapi = toOpenAPI(app) // OpenAPI 3.1
```

- **`t` builder** — `string`/`number`/`integer`/`boolean`/`null`/`literal`/`object`/
  `array`/`optional`/`union`/`record`, with options (`min`/`max`, `pattern`, `format`,
  …) that become JSON Schema constraints. Validators are compiled (fast).
- **Validating string formats** — `email`/`uuid`/`date-time`/`date`/`time`/`uri`/`ipv4`
  validate *and* annotate; register more with `registerFormat`.
- **`toOpenAPI`** — richest from a contract (it carries `response` schemas + op names →
  `operationId`s); also works on a live app. Routes using a BYO Standard Schema are
  emitted without a detailed schema (Standard Schema exposes no JSON Schema).

### `toOpenAPI` coverage

It emits `paths`, `parameters` (path + object query), `requestBody`, and `responses`, plus:

- **`servers`**, **top-level `tags`**, and an info **`description`** (document options).
- **`securitySchemes`** → `components.securitySchemes`, a document-wide **`security`**, and per-operation
  `security` (`[]` marks an operation explicitly public).
- **Non-200 responses** and **non-JSON content** — a contract op's `responses` map declares extra status
  codes; `requestContentType` / `responseContentType` set media types other than `application/json`.
- **`$ref` reuse** — a schema with a `$id` (`t.object({…}, { $id: "User" })`) is hoisted into
  `components.schemas` once and referenced by `$ref` everywhere it's used.
- Per-operation **`summary`**, **`description`**, **`tags`**, **`deprecated`** — declared on the contract op.

A **contract** is richest (its ops carry all of the above); in **app** mode a route's response is a
generic `200` with no schema — declare a `defineContract` with `response` schemas, or pass
`options.operations` (keyed by `"METHOD /path"`) to enrich app routes. Routes using a BYO Standard Schema
are still emitted without body/response detail (Standard Schema exposes no JSON Schema).

`@nifrajs/core` is a peer dependency. ESM-only. MIT.
