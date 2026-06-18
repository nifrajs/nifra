---
title: Getting started
description: Install nifra, write your first server, and call it with a fully typed client.
---

nifra is **Bun-native** (it uses `Bun.serve`) and **ESM-only**. You'll need [Bun](https://bun.sh).

## Install

```sh
bun add @nifrajs/core            # the server + router + contracts
bun add @nifrajs/client          # the typed client (browser-safe)
bun add @nifrajs/schema          # the `t` schema builder + OpenAPI (optional)
bun add @nifrajs/middleware      # CORS, security headers, rate limiting (optional)
```

## Your first server

Routes are chainable and fully type-inferred — `c.params.id` is typed from the path.

```ts
// server.ts
import { server } from "@nifrajs/core"

export const app = server()
  .get("/", () => ({ hello: "world" }))
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .listen(3000)

export type App = typeof app
```

## Call it with a typed client

The client's types come from `typeof app` — no codegen, no schema duplication.

```ts
// client.ts
import { client } from "@nifrajs/client"
import type { App } from "./server"

const api = client<App>("http://localhost:3000")

const { ok, status, data, error } = await api.users({ id: "42" }).get()
//      ^ boolean   ^ number  ^ { id: string } | null   ^ typed error | null

if (data) console.log(data.id)
```

Path segments are properties, `:params` are calls, and verbs are methods:
`api.users({ id }).posts({ postId }).get()`. The root path is `api.index`.

## Try it without a port

`app.fetch(Request)` runs the whole lifecycle in-process — great for tests:

```ts
const res = await app.fetch(new Request("http://localhost/users/42"))
console.log(res.status, await res.json()) // 200 { id: "42" }
```

## Next

- [Server & routing](/guides/server/) — params, context, lifecycle, hardening
- [Validation & OpenAPI](/guides/validation/) — the `t` builder + `toOpenAPI`
- [Contracts & the client](/guides/contracts/) — the decoupled, versionable surface
- [Middleware & hardening](/guides/middleware/) — CORS, security headers, rate limiting
