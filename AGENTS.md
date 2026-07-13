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
- **Reading secrets/env in a server handler.** `process.env.X` is `undefined` in the browser (keep secret
  reads server-side), but on the SERVER it's there on Bun/Node/Deno **and** on Workers/Pages with
  `nodejs_compat` — Cloudflare then populates `process.env` from the deployment's vars + secrets (a
  `wrangler … secret put` value lands in `process.env`). So with `nodejs_compat` on, `process.env.KEY` is the
  one portable, type-safe server read. `ctx.env` is the raw platform binding (typed `Env`); reach for it only
  when you can't enable `nodejs_compat`, and then declare the shape (`LoaderArgs<typeof backend, Env>`) or cast
  — an arbitrary key off the typed `Env` fails `TS2339`.
- **Loaders/actions are typed with `LoaderArgs`/`ActionArgs` from `@nifrajs/client`** — e.g.
  `export async function action({ request }: ActionArgs<typeof backend>)`. They are NOT `LoaderFunctionArgs`/
  `ActionFunctionArgs`, and never imported from `@nifrajs/core` — those are Remix shapes and fail with
  `TS2305: no exported member` (a frequent LLM mistake).
- **Loader data** arrives as `props.data` (not spread into props).
- **Dynamic `[param]`**: plain SSR runs the loader for ANY param value — guard and
  `throw new Response("", { status: 404 })` for unknown ids.
- **React is deduped** in both the build and the vite dev server, so a `file:`-linked package shipping
  its own React no longer nulls the SSR hook dispatcher.
- **Server-only code** → three ways to keep it out of the browser bundle:
  - put it in a `*.server.ts` module — the client build empties it (its `node:` / native imports never
    ship), no extra import needed;
  - for **pure server logic with no `node:` import** (a secret, a server-only API call), add
    `import "@nifrajs/web/server-only"` at the top — the client build fails loud, naming the import
    **chain**, if that module ever reaches a browser chunk (the node-builtin guard can't catch it);
  - mark the value's type `ServerOnly<T>` (from `@nifrajs/web`) to document intent — but it's
    type-level only and erases at build, so always pair it with `.server.ts` or the import marker.
  - or import a heavy / `node:`-using npm SDK (stripe, a DB driver, an API client) DYNAMICALLY *inside* the
    `loader`/`action`: `const X = (await import('pkg')).default` — it then never sits in the route's
    top-level (client-reachable) scope, so its `node:` builtins can't leak into the browser bundle.
  A server-only import **co-located** in a route file fails the build loud — error: `… reached the
  client bundle via <chain>`. `nifra check` reports the same transitive chain pre-build. See
  `/docs/troubleshooting` (keyed on the literal error strings).
- Run **`nifra check`** (`--json` for agents) as the done-gate: typecheck + typed-client drift +
  server-only-import-in-a-route + raw-`Response`-from-a-route + undeclared dependency. When capability
  assurance is configured, this also fails on raw effect-import bypasses and declaration/evidence drift.
- If the project has `nifra.assurance.ts`, also run **`nifra assure`** (`--json` in CI). It fails closed
  when a route is unclassified or lacks/forbids the enforcement evidence required by its first policy rule.
- If that config declares `capabilities`, commit the output of **`nifra capabilities snapshot`** and run
  **`nifra capabilities check`** in CI. Never auto-update the lockfile in CI; privilege additions need a
  reviewed lockfile diff.

## Build & deploy

`bun run build` / `nifra build` → client + server bundles (URL-safe chunk names, React deduped,
content-hashed, immutable assets). One `app.fetch` runs on Bun / Node / Deno / Cloudflare Pages /
Vercel / any VPS. `prerenderRoutes` + `cloudflarePagesRoutes` (`@nifrajs/web/build`) emit the static
output + `_routes.json`.
