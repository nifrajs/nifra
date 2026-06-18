---
title: Validation & OpenAPI
description: Validate requests with the built-in `t` builder (or any Standard Schema), and generate OpenAPI for free.
---

A route's `body` and `query` accept any [Standard Schema](https://standardschema.dev) —
zod, valibot, arktype, or nifra's own `t`. Invalid input is rejected with a structured
`400` before your handler runs; valid input is fully typed on `c.body` / `c.query`.

## The `t` builder

`@nifrajs/schema`'s `t` is TypeBox-backed: validators are compiled (fast), and every
schema **is** a JSON Schema — which is what makes OpenAPI free.

```ts
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"

const app = server().post(
  "/users",
  { body: t.object({ name: t.string(), age: t.integer({ minimum: 0 }) }) },
  (c) => ({ id: "u1", name: c.body.name, age: c.body.age }), // typed + validated
)
```

Constructors: `string`, `number`, `integer`, `boolean`, `null`, `literal`, `object`,
`array`, `optional`, `union`, `record`. Options (`minLength`, `pattern`, `format`,
`minimum`, …) become JSON Schema constraints.

### Validating string formats

`format` both validates and annotates — `email`, `uuid`, `date-time`, `date`, `time`,
`uri`, `ipv4` ship registered:

```ts
t.string({ format: "email" }) // rejects non-emails; appears as `format: "email"` in OpenAPI
```

Register your own with `registerFormat(name, (value) => boolean)`.

## OpenAPI

```ts
import { toOpenAPI } from "@nifrajs/schema"

const doc = toOpenAPI(app, { title: "Users API", version: "1.0.0" }) // OpenAPI 3.1
```

`toOpenAPI` is richest from a **contract** (it carries `response` schemas, and op names
become `operationId`s). Routes that use a BYO Standard Schema are emitted without a
detailed schema — only `t`/TypeBox schemas expose JSON Schema.

## Bring your own validator

```ts
import { z } from "zod"

server().post("/users", { body: z.object({ name: z.string() }) }, (c) => c.body.name)
```

It validates exactly the same way; only OpenAPI body/response detail is `t`-specific.
