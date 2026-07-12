# nifra

**The full-stack TypeScript framework built for AI agents — and for the humans who work alongside them.**

Coding agents drift. They call an endpoint that moved, expect a response shape that changed, or hand-roll `fetch` with ad-hoc types that fall out of sync the moment a route changes. nifra removes that class of bug at the framework level:

| | |
|---|---|
| **Typed client** | `client<typeof app>` infers every path, param, body, and response from your server's TypeScript type. Any mismatch is a compile error. |
| **`nifra check`** | Runs typecheck + typed-client lint in one command. Add it to CI — it fails the moment the frontend and backend drift. |
| **AGENTS.md** | Every scaffold ships a conventions file. Agents (Claude Code, Cursor, Copilot) read it and follow nifra's rules from the first prompt. |
| **`nifra context`** | Prints this project's real API surface — routes + schemas — as Markdown. Paste into any agent prompt, or let `nifra mcp` deliver it automatically. |
| **`nifra mcp`** | An MCP server that feeds Claude Code, Cursor, and Copilot Chat this project's live route and schema data. |

The rest is a fast, contract-first full-stack TypeScript stack: routing, validated I/O, SSR, loaders/actions, auth, WebSockets, MDX, and multi-runtime deployment.

```sh
bun create nifra my-app
```

## The backend

```ts
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: t.object({ name: t.string() }) }, (c) => {
    // c.body is validated + typed — invalid input is rejected before this runs.
    return { id: crypto.randomUUID(), name: c.body.name }
  })
  .listen(3000)

export type App = typeof app
```

## The typed client — the anti-drift seam

```ts
// client.ts — fully typed from the server, zero codegen
import { client } from "@nifrajs/client"
import type { App } from "./server"

const api = client<App>("http://localhost:3000")

const res = await api.users({ id: "42" }).get()
if (res.ok) res.data.id   // typed from the route's return — tsc fails if the route changes
else res.error            // errors are returned, never thrown
```

The client **never throws** — every call returns `{ ok, status, data, error }`, so the happy path and the failure path are both in the types.

## Agent tooling

nifra ships a purpose-built toolchain so coding agents stay correct as the codebase evolves.

**AGENTS.md** — generated per scaffold, teaches the agent nifra's non-obvious rules:
- validate every input at the boundary with `t` or any Standard Schema
- always call this app's own API through `client<typeof app>` — never hand-roll `fetch`
- never top-level-import server-only code into a route module

**Connect the MCP server** so the agent reads your live routes, verifies endpoints, and gates drift from inside its tool loop. Run once from your project root:

```sh
# Claude Code
claude mcp add nifra -- bunx nifra mcp

# Cursor / Claude Desktop — add to .mcp.json (or claude_desktop_config.json):
# { "mcpServers": { "nifra": { "command": "bunx", "args": ["nifra", "mcp"] } } }
```

Once connected, the agent has fifteen tools — no setup per prompt:

| Tool | What it does |
|---|---|
| `nifra_context` | This project's live routes + schemas + the exact typed-client **call signature** per route (Markdown). |
| `nifra_routes` | The same routes as **structured JSON** (`{ method, path, call, body?, query?, response? }`) — for programmatic use. |
| `nifra_openapi` | OpenAPI 3.1 generated from backend route schemas, as JSON or YAML. |
| `nifra_check` | Typecheck + drift lint, returned as **structured JSON** with safe fix suggestions. |
| `nifra_assure` | Classify every route and verify required/forbidden enforcement evidence. |
| `nifra_doctor` | Flags packages imported in source but missing from `package.json` (resolve at runtime, break `tsc`). |
| `nifra_run` | Calls a route **in-process** (via `@nifrajs/runner`) — the agent self-verifies an endpoint without booting a server. |
| `nifra_render` | Server-renders a page to HTML — verify SSR output. |
| `nifra_ws` | Opens a real Bun WebSocket against the current app, sends test frames, and returns structured evidence. |
| `nifra_test` | Runs bounded `bun test` and returns structured stdout, stderr, timing, and summary. |
| `nifra_scaffold` | URL pattern → the correct `routes/` file for the chosen UI framework. |
| `nifra_docs` / `nifra_example` | Search the docs / fetch a **version-checked** snippet that compiles as-is (no hallucinated APIs). |
| `nifra_types` | Look up the exact current TypeScript signature for any public Nifra export. |
| `nifra_fix` | Apply safe mechanical fixes, then return unresolved diagnostics. |

No MCP? The same data is available as plain commands — paste into any prompt, or run in CI:

```sh
nifra context          # routes + schemas (+ per-route call signatures) as Markdown
nifra check            # typecheck + typed-client drift lint; --json for agents, --lints-only to skip tsc
nifra assure           # policy gate for route auth/CSRF/rate/body/idempotency evidence; --json for CI
nifra doctor           # packages imported but not declared in package.json (--json for agents)
```

## Install

```sh
bun add @nifrajs/core            # the server + router + contracts
bun add @nifrajs/client          # the typed client (browser-safe)
bun add @nifrajs/schema          # the `t` schema builder + OpenAPI (optional)
bun add @nifrajs/middleware      # CORS, security headers, rate limiting (optional)
```

nifra is **ESM-only** and **Bun-native** (it uses `Bun.serve`). It runs on Bun; the client is environment-agnostic.

## Validate input with `t` (and get OpenAPI for free)

`@nifrajs/schema`'s `t` is a TypeBox-backed builder: it validates at the request boundary *and* — because a TypeBox schema **is** a JSON Schema — generates OpenAPI with no extra work. Bring your own [Standard Schema][standard-schema] (zod, valibot, arktype) too; they validate identically.

```ts
import { server } from "@nifrajs/core"
import { t, toOpenAPI } from "@nifrajs/schema"

const app = server().post("/users", { body: t.object({ name: t.string() }) }, (c) => ({
  id: "u1",
  name: c.body.name, // typed as string, validated at runtime
}))

const openapi = toOpenAPI(app) // OpenAPI 3.1 document
```

Invalid bodies are rejected with a structured `422` before your handler runs.

## Graduate to a contract — handlers unchanged

When you want a decoupled, versionable API surface, lift the same routes into a contract. Handlers written inline lift over **unchanged**.

```ts
import { defineContract, implement } from "@nifrajs/core"
import { t } from "@nifrajs/schema"

const contract = defineContract({
  getUser:    { method: "GET",  path: "/users/:id", response: t.object({ id: t.string(), name: t.string() }) },
  createUser: { method: "POST", path: "/users",     body: t.object({ name: t.string() }), response: t.object({ id: t.string(), name: t.string() }) },
})

const app = implement(contract, {
  getUser:    (c) => ({ id: c.params.id, name: "ada" }),
  createUser: (c) => ({ id: "new", name: c.body.name }),
})
```

The client can now be built from the **contract** alone (`client(contract, url)`) — no dependency on the server's source. This is the shape agents reference: `nifra context` emits the live contract; `nifra check` enforces it.

## Harden it

```ts
import { server } from "@nifrajs/core"
import { cors, securityHeaders, rateLimit, MemoryStore } from "@nifrajs/middleware"

const app = server()
  .use(securityHeaders())
  .use(cors({ origin: ["https://app.example.com"], credentials: true }))
  .use(rateLimit({
    store: new MemoryStore(),
    max: 100,
    windowMs: 60_000,
    key: (req) => req.headers.get("x-user-id") ?? "anonymous",
  }))
  .get("/", () => ({ ok: true }))

// Graceful shutdown, request timeout, body-size cap, redacting logger are built in:
server({ requestTimeoutMs: 5_000, gracefulSignals: true })
```

Official hardening modules also publish route evidence. Add a `nifra.assurance.ts` policy and run
`nifra assure` in CI to fail when a new route is unclassified or misses required authentication, CSRF,
rate-limit, body-limit, idempotency, IP, or security-header enforcement. The proof is built from route
reflection, so it adds no request-path work. See [Security & hardening](site/routes/docs/security.tsx).

## Runs on the edge, too

Bun is the first-class runtime (`app.listen()`), but the whole lifecycle is `app.fetch(Request): Promise<Response>` with zero Bun APIs — so the same `app` deploys to **Cloudflare Workers** (`export default app`), **Deno** (`Deno.serve(app.fetch)`), or **Node** (via the [`@nifrajs/node`](packages/node) adapter). See [Deployment](site/routes/docs/deployment.tsx) and [Edge & bindings](site/routes/docs/edge.tsx).

## Principles (enforced, not aspirational)

- **Reject invalid input at three boundaries** — compile-time (types), boot-time (config throws loudly), request-time (Standard Schema → structured `422`). "Genuine fallback" is a documented whitelist; everything else rejects.
- **Tests everywhere, six kinds** — unit, type-level (`*.test-d.ts`), property/fuzz, mode-conformance, benchmark-regression, security-guardrail.
- **Speed is a measured goal** — tracked with the `oha` HTTP matrix (`bun run bench:loadtest`) across Bun, Node, and Deno against raw runtime handlers plus representative API framework baselines.
- **Production-grade by default** — graceful shutdown, redacting logs, idempotent guards, integer-money discipline; nothing is "we'll fix it later".

## Packages

| Package | What it is |
|---|---|
| [`@nifrajs/core`](packages/core) | Router, fully-inferred server, contracts, lifecycle middleware, hardening |
| [`@nifrajs/budget`](packages/budget) | Absolute request deadlines, monotonic remaining time, child reserves, wire propagation |
| [`@nifrajs/client`](packages/client) | End-to-end-typed, never-throwing client (Eden-style proxy) |
| [`@nifrajs/schema`](packages/schema) | TypeBox-backed `t` builder + `toOpenAPI` |
| [`@nifrajs/middleware`](packages/middleware) | CORS, security headers, rate limiting |
| [`@nifrajs/testing`](packages/testing) | Contract-derived hostile inputs, response conformance, runtime matrices, test sessions |
| [`@nifrajs/node`](packages/node) | Run a nifra app on Node's `http` server (opt-in) |
| [`@nifrajs/cli`](packages/cli) | `nifra check`, `nifra context`, `nifra mcp` — the agent toolchain |

## Examples

Runnable, type-checked apps live in [`examples/`](examples):

```sh
bun run examples/inline-server.ts
bun run examples/contract-client.ts
bun run examples/schema-openapi.ts
bun run examples/hardened.ts
bun run examples/edge.ts        # app.fetch as a universal handler
```

## Develop

```sh
bun install
bun run check          # lint + typecheck (incl. type-level tests) + tests w/ coverage
bun run build          # emit dist/ (js + d.ts) for all packages
bun run check:publish  # build + publint + arethetypeswrong
bun run bench:loadtest # oha HTTP matrix across Bun/Node/Deno
```

MIT licensed.

[standard-schema]: https://standardschema.dev
