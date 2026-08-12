---
name: nifra-api
description: Use when building or changing a typed JSON API in Nifra - routes with server() or defineContract, request validation with @nifrajs/schema or any Standard Schema library, middleware and plugins, WebSockets, OpenAPI, and consuming the API from the zero-codegen @nifrajs/client. Load after the `nifra` skill.
metadata:
  docs: https://nifra.dev/docs/api
---

# Nifra: typed APIs and the typed client

Fetch exact signatures with `nifra_types` and compiling snippets with `nifra_example` before writing
anything non-trivial. This skill is the shape of the thing, not a substitute for either.

## Two ways to declare routes

**`server()`** - chainable, inference-first. Reach for this by default.

```ts
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

export const app = server()
  .get("/notes", () => listNotes())
  .get("/notes/:id", { params: t.object({ id: t.string() }) }, (c) => getNote(c.params.id))
  .post("/notes", { body: t.object({ title: t.string(), body: t.string() }) }, (c) =>
    createNote(c.body),
  )
```

**`defineContract`** - the same routes as a standalone, versionable artifact when the contract must
be published, shared across repos, or evolved independently of the handlers. Ask `nifra_docs` for
the contract page before choosing it; do not reach for it just because a route feels important.

## Validation belongs in the route options

`body`, `query`, `params`, `headers`, and `response` all take a schema. Anything that fails becomes a
structured `422` before your handler runs, so a handler never defensively re-checks its own input.

`@nifrajs/schema` (`t`) is TypeBox-backed and gives you JSON Schema and OpenAPI for free. Any
[Standard Schema](https://standardschema.dev) library works too - Zod and Valibot slot into the same
option with no adapter.

```ts
import { z } from "zod"
app.post("/users", { body: z.object({ email: z.string().email() }) }, (c) => c.body.email)
```

Typed search params: declare `query` and read `c.query` typed. Do not parse `new URL(c.req.url)` by
hand.

## The client never throws

```ts
const res = await api.notes({ id }).get()
if (!res.ok) return handle(res.error)   // transport and HTTP failures both land here
res.data                                // typed from the route's return type
```

Three consequences worth internalising:

- No `try`/`catch` around a client call for HTTP or network failure. Only genuinely exceptional code
  throws.
- The client is browser-safe. It carries the server's *types*, never its code.
- Changing a route's shape breaks every caller at compile time. That is the feature. Fix the callers;
  do not widen the type to silence `tsc`.

## Middleware

`@nifrajs/middleware` ships the production set: `requestId`, `logger`, `etag`, `bearer`, `apiKey`,
`basicAuth`, `jwt`/`jwks`, `csrf`, `ipRestriction`, `bodyLimit`, `cors`, `securityHeaders`,
`rateLimit`, `compression`, `cacheControl`, `cache`, `prettyJson`, `timing`, `methodOverride`,
`trailingSlash`, `language`, `poweredBy`, `combine`, `openapi`, `healthcheck`, `idempotency`.

Check that list before writing your own. Hand-rolled CORS, rate limiting, or CSRF is how a project
acquires a security hole. Custom cross-cutting behaviour goes through `definePlugin` (typed context,
idempotent registration), not a hand-patched handler wrapper.

## WebSockets

`app.ws(path, handler)` registers a typed WebSocket route: upgrade guard, portable socket,
contract-validated messages, topic pub/sub. Served on Bun, Deno, Node, and Workers. Ask
`nifra_example` for the current shape; the message-contract generics are easy to get wrong from memory.

## Runtimes

The app is `app.fetch(Request): Promise<Response>`. Bun is first-class; Node
(`@nifrajs/node`), Deno (`@nifrajs/deno`), Workers (`@nifrajs/workers`), Lambda
(`@nifrajs/aws-lambda`), and Vercel Edge are each one adapter import. Do not fork the app per target.

## Common mistakes

| Mistake | Do instead |
|---|---|
| `fetch("/api/notes")` inside the same project | `client<typeof app>()`, or `ctx.api` in a loader |
| `try { await api.x.get() } catch` | Check `res.ok` |
| Validating in the handler body | Put the schema in the route options |
| Reading `c.req.headers.get("x-forwarded-for")` for the caller IP | Use the documented request helper; proxy headers are forgeable |
| Hand-writing an OpenAPI document | `openapi` middleware derives it from the schemas |
