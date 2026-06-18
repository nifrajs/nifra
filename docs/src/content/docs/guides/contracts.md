---
title: Contracts & the client
description: Graduate from inline routes to a decoupled, versionable contract — handlers unchanged — and type the client from it.
---

Inline routes are great solo. When you want a **decoupled, versionable** API surface —
shared with other teams, other languages, or a separately-deployed client — lift the
same routes into a contract. **Handlers written inline lift over unchanged.**

## Define & implement

```ts
import { defineContract, implement } from "@nifrajs/core"
import { t } from "@nifrajs/schema"

const contract = defineContract({
  getUser: {
    method: "GET",
    path: "/users/:id",
    response: t.object({ id: t.string(), name: t.string() }),
  },
  createUser: {
    method: "POST",
    path: "/users",
    body: t.object({ name: t.string() }),
    response: t.object({ id: t.string(), name: t.string() }),
  },
})

const app = implement(contract, {
  getUser: (c) => ({ id: c.params.id, name: "ada" }),     // c is typed from the op
  createUser: (c) => ({ id: "new", name: c.body.name }),
})
```

`defineContract` validates at boot (known methods, leading-slash paths, no duplicate
`(method, path)`); `implement` returns a real `Server` you can `.listen()` or `.fetch()`.
The op **name** is the handler key and the OpenAPI `operationId`.

## Type the client from the contract

The coupled client uses `typeof app`; the **decoupled** client uses the contract alone —
no dependency on the server's source:

```ts
import { client } from "@nifrajs/client"

const api = client(contract, "https://api.example.com")

const { data } = await api.users({ id: "42" }).get()
//      ^? { id: string; name: string } | null  — from the contract's response schema
```

This is the graduation payoff: the same handlers, now behind a versionable contract
that can be published, diffed, and consumed by anyone — while the inline ergonomics
were never compromised.

## Conformance

The inline and contract-implemented servers are route-for-route identical (a tested
invariant), so moving between them is safe — your handlers and tests don't change.
