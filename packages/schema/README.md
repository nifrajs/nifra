# @nifrajs/schema

The optional, batteries-included schema builder for [nifra](../../README.md): `t` is
TypeBox-backed, so it **validates** at the boundary *and* gives you **OpenAPI for
free** (a TypeBox schema is a JSON Schema). Plus `toOpenAPI(contract | app)`.

```sh
bun add @nifrajs/schema
```

```ts
import { server } from "@nifrajs/core/server"
import { t, toOpenAPI } from "@nifrajs/schema"

const app = server().post("/users", { body: t.object({ name: t.string(), age: t.integer() }) }, (c) => ({
  id: "u1",
  name: c.body.name, // typed + validated
}))

const openapi = toOpenAPI(app) // OpenAPI 3.1
```

- **`t` builder** - `string`/`number`/`integer`/`boolean`/`null`/`literal`/`object`/
  `array`/`optional`/`union`/`record`, with options (`min`/`max`, `pattern`, `format`,
  …) that become JSON Schema constraints. Validators are compiled (fast).
- **Validating string formats** - `email`/`uuid`/`date-time`/`date`/`time`/`uri`/`ipv4`
  validate *and* annotate; register more with `registerFormat`.
- **`toOpenAPI`** - richest from a contract (it carries `response` schemas + op names →
  `operationId`s); also works on a live app. A Standard Schema that also implements Standard JSON
  Schema (zod 4 does) is described like `t`; one that exposes no JSON Schema is emitted without a
  detailed schema.

### Static validators for edge runtimes

`@nifrajs/schema/compile` generates a TypeScript module at build time. Import that generated module
in the server: its validator runs without `new Function`, retains the source schema's inferred types,
and keeps the schema builder and dynamic compiler out of the runtime bundle. Invalid data still
produces the same structured issues, capped at 100.

Define the source schema in `src/schemas/users.ts`:

```ts
import { t } from "@nifrajs/schema"
export const body = t.object({ name: t.string({ minLength: 1 }), age: t.integer() })
```

Generate `src/generated/users.ts` before building the app:

```ts
import { compileSchema } from "@nifrajs/schema/compile"
import { body } from "../src/schemas/users.ts"

await Bun.write(
  "src/generated/users.ts",
  compileSchema(body, { source: "../schemas/users.ts", exportName: "body" }),
)
```

The server imports `body` from `./generated/users.ts` and uses it as its route schema. The generated
source-schema import is type-only and disappears from the deployed bundle. Regenerate when the source
schema changes. Custom string formats must be registered in the serving process, as with ordinary schemas.

Compilation refuses coercing schemas (`t.query`, `t.form` and the other request-slot schemas), a
schema whose `validate` does more than check its `jsonSchema`, custom registry kinds such as dates/deferred values,
runtime-only metadata, and known TypeBox compiler escape hazards. Use the ordinary `t` adapter for
these shapes. This opt-in build step leaves the existing validation API and runtime behavior intact.

### Forms and files - `@nifrajs/schema/form`

The `t` exported from `@nifrajs/schema/form` is the same builder plus `t.file` and `t.form`. A
`t.form` is a route `body` that reads `multipart/form-data`: text fields and files validated side by
side, typed in `c.body`.

```ts
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema/form"

const app = server().post(
  "/avatars",
  {
    body: t.form({
      avatar: t.file({ maxBytes: 5_000_000, accept: ["image/png", "image/jpeg"] }),
      photos: t.array(t.file({ accept: ["image/*"] }), { maxItems: 8 }),
      caption: t.optional(t.string({ maxLength: 200 })),
    }),
    bodyLimit: 50_000_000, // the default body cap is 1 MB
  },
  (c) => ({ bytes: c.body.avatar.size, photos: c.body.photos.length }),
)
```

- **`t.file({ maxBytes, accept })`** - a `File`. The size is checked before a byte is read, and
  `accept` is matched against the file's leading bytes, never the type the client claimed. With
  `accept` set, the validated file's `type` is the detected one. A type with no signature to check
  (`text/csv`, `image/svg+xml`) throws when the schema is built.
- **`t.form(fields, options?)`** - text fields are coerced from their string form, a repeated field
  is a list, and an undeclared field fails unless `additionalProperties` is set. `options` also takes
  the body limits: `maxFields` (100), `maxFiles` (10), `maxFieldBytes` (64 KiB), `maxFileBytes`. A
  request over one is a `413`.
- **Composes with the plain `t`** - `t.array(file)` and `t.optional(file)` work from either import. A
  file anywhere else (`t.object`, `t.union`, `t.record`) throws: a file is not JSON.
- **`toOpenAPI`** emits a form with a file as `multipart/form-data` with `format: binary` fields.
- **A form with no required file also accepts JSON and urlencoded bodies**, so one route serves an
  HTML form and a script.

It is a subpath so that an app with no uploads carries none of it. Validation proves a file's
signature and nothing more: generate your own storage key rather than using `file.name`, serve
uploads with `content-disposition: attachment`, and protect cookie-authenticated upload routes with
`csrf()` - a browser posts a form cross-origin without a preflight. The
[security guide](https://nifra.dev/docs/security) has the full list.

A hand-rolled Standard Schema can validate a form too: wrap it in `multipartBody(schema, limits?)`
from `@nifrajs/core/multipart`.

### `t` vs bring-your-own (bundle size)

`t` is the batteries-included default because a TypeBox schema *is* a JSON Schema: it gives you
OpenAPI + MCP `tools/list` for free and compiles to a fast validator. That completeness has a
cost - TypeBox carries the whole JSON Schema type system, so `t` adds meaningful bytes to a bundle.

nifra validates through **Standard Schema**, so any Standard-Schema validator works on a route with
no adapter - `{ body: v.object({ ... }) }` with valibot, for instance. A validated app built on a
lean validator like valibot is a fraction of the size (measured ~16 KB gzipped), which matters for
edge/Workers cold-starts. The trade is the one noted above: a validator that exposes no JSON Schema
(valibot without a Standard JSON Schema wrapper) gives those routes no OpenAPI/MCP detail. One that
implements Standard JSON Schema (`~standard.jsonSchema`, as zod 4 does) is described from it.

Rule of thumb: reach for `t` when you want the contract (OpenAPI/MCP) for free; bring valibot (or any
Standard-Schema validator) when bundle size on the edge is the priority. Both are first-class - the
choice is per route, and you can mix them in one app.

### `toOpenAPI` coverage

It emits `paths`, `parameters` (path + object query), `requestBody`, and `responses`, plus:

- **`servers`**, **top-level `tags`**, and an info **`description`** (document options).
- **`securitySchemes`** → `components.securitySchemes`, a document-wide **`security`**, and per-operation
  `security` (`[]` marks an operation explicitly public).
- **Non-200 responses** and **non-JSON content** - a contract op's `responses` map declares extra status
  codes; `requestContentType` / `responseContentType` set media types other than `application/json`.
- **`$ref` reuse** - a schema with a `$id` (`t.object({…}, { $id: "User" })`) is hoisted into
  `components.schemas` once and referenced by `$ref` everywhere it's used. A Standard JSON Schema's
  `$defs` are hoisted the same way, so its refs resolve inside the document.
- **Framework errors** - the responses the server answers before a handler runs, as the shared
  `NifraError` (`{ ok: false, error }`) and `NifraValidationError` (`{ ok: false, error: "validation",
  issues }`) components: `400`, `413` and `415` on a route with a body, `422` on any route with a request
  schema (left out when an `onValidationError` hook writes that body). A declared response wins.
- **Tagged unions** - a union whose members all pin one required property to distinct values is
  emitted as a `oneOf`. When every member is a component (a `$id`) it also gets a `discriminator`
  with a `mapping`, so a client generator can build a tagged union; OpenAPI discriminators never
  consider inline members.
- Per-operation **`summary`**, **`description`**, **`tags`**, **`deprecated`** - declared on the contract op.

A **contract** is richest (its ops carry all of the above); in **app** mode a route's response is a
generic `200` with no schema - declare a `defineContract` with `response` schemas, or pass
`options.operations` (keyed by `"METHOD /path"`) to enrich app routes. Routes using a schema that
exposes no JSON Schema are still emitted without body/response detail.

`@nifrajs/core` is a peer dependency. ESM-only. MIT.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
