# AGENTS.md — Nifra quick reference for coding agents

Nifra is a Bun-native, multi-runtime, end-to-end-typed full-stack TS framework. This is the
copy-paste cookbook so you don't have to read the source. Deeper docs live in `docs/` and at
`/docs/contract`. Machine surfaces for agents: **`nifra check --json`** (the done-gate),
**`nifra context`**, and the MCP server (`nifra mcp`).

## 1 · Define a route (typed, chainable)

```ts
import { server } from "@nifrajs/core"

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id })) // c.params typed from the path literal
  .get("/files/*path", (c) => ({ path: c.params.path })) // trailing wildcard
```

Return a value → serialized to JSON. Return a `Response` → used as-is.

## 2 · Validate a body/query at the trust boundary (auto-400)

```ts
import { t } from "@nifrajs/schema"

app.post(
  "/users",
  { body: t.object({ name: t.string({ minLength: 1 }), age: t.number() }) },
  (c) => ({ id: crypto.randomUUID(), name: c.body.name }), // c.body is typed + already validated
)
```

`t.object` rejects unknown fields by default (`additionalProperties: false`) → a `400 { path: [...] }`
**before** the handler runs. Need to allow extras? `t.looseObject`. Query schema: `{ query: t.object({…}) }` → `c.query`.

## 3 · Read platform env (KV / D1 / secrets)

```ts
// Type it ONCE on server<Env>() → c.env is typed everywhere below (no per-binding cast).
const app = server<{ MY_KV: KVNamespace; API_SECRET: string }>().get(
  "/x",
  (c) => c.env.API_SECRET, // c.env: Env  (it's `unknown` if you don't pass <Env>)
)
```

`env` is forwarded from `app.fetch(request, { env })` (Workers bindings). Validate at the boundary.

## 4 · Set status / headers, and the control-flow rule

```ts
app.post("/things", { body: t.object({ name: t.string() }) }, (c) => {
  c.set.status = 201
  c.set.headers["x-created"] = "1"
  return { ok: true }
})
```

For full control, return a `Response`. **Throw rule:** `throw new Response("", { status: 404 })` =
an intentional HTTP response (control flow — bypasses `_error`); `throw new Error(…)` = the nearest
`_error` boundary / a 500.

## 5 · Call it with the end-to-end typed client (no codegen)

```ts
import { client, inProcessClient } from "@nifrajs/client"

const api = client<typeof app>("") // `import type { app }` — the type is erased at build
const res = await api.users.post({ name: "Ada", age: 36 })
if (res.ok && "id" in res.data) res.data.id // narrows cleanly

const local = inProcessClient(app) // SSR loaders / tests: same call, no network
```

## 6 · Mount the backend in a web app (dev AND prod)

```ts
import { createWebApp } from "@nifrajs/web"
import { inProcessClient } from "@nifrajs/client"
import { backend } from "./backend"

const app = createWebApp({
  adapter,
  manifest,
  clientEntry,
  api: inProcessClient(backend), // feeds ctx.api to loaders AND serves the backend over HTTP
})
```

The backend's routes are auto-mounted under `apiPrefix` (default `"/api"`), so `POST /api/*` hits the
backend in `nifra dev` and in prod alike — no hand-dispatch in `server-bun.ts` / `_worker.ts`. Set
`apiPrefix: ""` to opt out and dispatch yourself.

## Gotchas (the documented time-sinks)

- **`PUBLIC_*` env** is baked into the client bundle (Vite/Next convention). Any other `process.env.X`
  compiles to `undefined` in the browser — no `process is not defined` crash, and secrets can't leak.
- **Loader data** arrives as `props.data` (not spread into props).
- **Dynamic `[param]`**: plain SSR runs the loader for ANY param value — guard and
  `throw new Response("", { status: 404 })` for unknown ids.
- **React is deduped** in both the build and the vite dev server, so a `file:`-linked package shipping
  its own React no longer nulls the SSR hook dispatcher.
- Run **`nifra check`** (`--json` for agents) as the done-gate: typecheck + typed-client drift +
  server-only-import-in-a-route + raw-`Response`-from-a-route + undeclared dependency.

## Build & deploy

`bun run build` / `nifra build` → client + server bundles (URL-safe chunk names, React deduped,
content-hashed, immutable assets). One `app.fetch` runs on Bun / Node / Deno / Cloudflare Pages /
Vercel / any VPS. `prerenderRoutes` + `cloudflarePagesRoutes` (`@nifrajs/web/build`) emit the static
output + `_routes.json`.
