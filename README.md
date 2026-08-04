# Nifra

**The full-stack TypeScript framework built for AI agents - and for the humans who work alongside them.**

Coding agents drift. They call an endpoint that moved, expect a response shape that changed, or hand-roll `fetch` with ad-hoc types that fall out of sync the moment a route changes. Nifra removes that class of bug at the framework level:

| | |
|---|---|
| **Typed client** | `client<typeof app>` infers every path, param, body, and response from your server's TypeScript type. Any mismatch is a compile error. |
| **`nifra check`** | Runs typecheck + typed-client lint in one command. Add it to CI - it fails the moment the frontend and backend drift. |
| **AGENTS.md** | Every scaffold ships a conventions file. Agents (Claude Code, Cursor, Copilot) read it and follow Nifra's rules from the first prompt. |
| **`nifra context`** | Prints this project's real API surface - routes + schemas - as Markdown. Paste into any agent prompt, or let `nifra mcp` deliver it automatically. |
| **`nifra mcp`** | An MCP server that feeds Claude Code, Cursor, and Copilot Chat this project's live route and schema data. |
| **Versioned transports** | One bounded codec registry for plain JSON or rich values across HTTP, loaders, and WebSocket frames. |
| **Durable effects** | Postgres, SQLite, and Durable Object stores plus leased, cursor-bounded reconciliation for approvals and sagas. |

The rest is a fast, contract-first full-stack TypeScript stack: routing, validated I/O, SSR, loaders/actions, auth, WebSockets, MDX, and multi-runtime deployment.

```sh
bun create nifra my-app
```

### Use Nifra from your AI assistant

Nifra's own docs, runnable examples, and API types are a **live remote MCP server** - listed in the [official MCP registry](https://registry.modelcontextprotocol.io) - so Claude, Cursor, Codex, and any MCP client learn Nifra from the source instead of guessing from stale training data:

- **Claude Code:** `claude mcp add --transport http nifra-docs https://mcp.nifra.dev`
- **Claude.ai / Desktop:** Settings → Connectors → Add custom connector → `https://mcp.nifra.dev`
- **Cursor / VS Code / other MCP clients:** point them at `https://mcp.nifra.dev`

Inside a project, register the **local** server instead - `claude mcp add nifra -- bunx nifra mcp`. It is the same MCP with the same docs tools built in (version-matched to your installed Nifra), plus the project tools that read *your* app's live routes and schemas - so the agent writes against the code you have, not the code it remembers. Project tools run only on your machine over stdio; your code never reaches `mcp.nifra.dev`. One MCP, two transports - the same hosted-plus-local pairing Supabase, Stripe, and GitHub use, and you never need both: local includes everything hosted has.

## The backend

```ts
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: t.object({ name: t.string() }) }, (c) => {
    // c.body is validated + typed - invalid input is rejected before this runs.
    return { id: crypto.randomUUID(), name: c.body.name }
  })
  .listen(3000)

export type App = typeof app
```

## The typed client - the anti-drift seam

```ts
// client.ts - fully typed from the server, zero codegen
import { client } from "@nifrajs/client"
import type { App } from "./server"

const api = client<App>("http://localhost:3000")

const res = await api.users({ id: "42" }).get()
if (res.ok) res.data.id   // typed from the route's return - tsc fails if the route changes
else res.error            // errors are returned, never thrown
```

The client **never throws** - every call returns `{ ok, status, data, error }`, so the happy path and the failure path are both in the types.

## Agent tooling

Nifra ships a purpose-built toolchain so coding agents stay correct as the codebase evolves.

**AGENTS.md** - generated per scaffold, teaches the agent Nifra's non-obvious rules:
- validate every input at the boundary with `t` or any Standard Schema
- always call this app's own API through `client<typeof app>` - never hand-roll `fetch`
- never top-level-import server-only code into a route module

**Adding Nifra to an existing app? Run `nifra init-agents`.** It writes the agent-discovery files for you - `.mcp.json` + `.cursor/mcp.json` (registering this project's Nifra MCP), a CLAUDE.md MCP-first preamble, and an AGENTS.md section - no-clobber, so it never overwrites a file you've customized. (`nifra check` also nudges you when a project has no `.mcp.json`.)

```sh
nifra init-agents          # wire .mcp.json + .cursor/mcp.json + CLAUDE.md into an existing app (no-clobber)
```

**Or connect the MCP server by hand** so the agent reads your live routes, verifies endpoints, and gates drift from inside its tool loop. Run once from your project root:

```sh
# Claude Code
claude mcp add nifra -- bunx nifra mcp

# Cursor / Claude Desktop - add to .mcp.json (or claude_desktop_config.json):
# { "mcpServers": { "nifra": { "command": "bunx", "args": ["nifra", "mcp"] } } }
```

Once connected, the agent has fifteen tools - no setup per prompt:

| Tool | What it does |
|---|---|
| `nifra_context` | This project's live routes + schemas + the exact typed-client **call signature** per route (Markdown). |
| `nifra_routes` | The same routes as **structured JSON** (`{ method, path, call, body?, query?, response? }`) - for programmatic use. |
| `nifra_openapi` | OpenAPI 3.1 generated from backend route schemas, as JSON or YAML. |
| `nifra_check` | Typecheck + drift lint, returned as **structured JSON** with safe fix suggestions. |
| `nifra_assure` | Classify every route and verify required/forbidden enforcement evidence. |
| `nifra_levels` | The cumulative verification ladder (L0 typed contract → L4 invariants): what the project proves, and why each level it misses does not hold. |
| `nifra_doctor` | Flags undeclared imports and duplicate physical Nifra/React installs. |
| `nifra_run` | Calls a route **in-process** (via `@nifrajs/runner`) - the agent self-verifies an endpoint without booting a server. |
| `nifra_render` | Server-renders a page to HTML - verify SSR output. |
| `nifra_ws` | Opens a real Bun WebSocket against the current app, sends test frames, and returns structured evidence. |
| `nifra_test` | Runs bounded `bun test` and returns structured stdout, stderr, timing, and summary. |
| `nifra_scaffold` | URL pattern → the correct `routes/` file for the chosen UI framework. |
| `nifra_docs` / `nifra_example` | Search the docs / fetch a **version-checked** snippet that compiles as-is (no hallucinated APIs). |
| `nifra_types` | Look up the exact current TypeScript signature for any public Nifra export. |
| `nifra_fix` | Apply safe mechanical fixes, then return unresolved diagnostics. |

No MCP? The same data is available as plain commands - paste into any prompt, or run in CI:

```sh
nifra context          # routes + schemas (+ per-route call signatures) as Markdown
nifra check            # typecheck + typed-client drift lint; --json for agents, --lints-only to skip tsc
nifra assure           # policy gate for route auth/CSRF/rate/body/idempotency evidence; --json for CI
nifra capabilities check # effect provenance + capability lockfile gate; --json for CI
nifra manifest emit    # deterministic contract + assurance + effects + classification artifact
nifra manifest diff old.json new.json # deploy-promotion breaking-change gate
nifra doctor           # undeclared imports + duplicate identity-sensitive installs
nifra sync-manifest    # regenerate a web server-manifest.ts from routes/ without a full build
```

**Learn Nifra from any assistant.** The docs, example, and type tools are also hosted,
project-independent, at `mcp.nifra.dev` - add that one URL to Claude, Cursor, VS Code, or ChatGPT and it
learns Nifra from the same verified corpora, no checkout. Read-only, no key.

```sh
claude mcp add --transport http nifra-docs https://mcp.nifra.dev
# Cursor / VS Code: add { "url": "https://mcp.nifra.dev" } to .cursor/mcp.json or .vscode/mcp.json
# Claude.ai / ChatGPT: Settings -> Connectors -> add the URL
```

See [Coding agents](https://nifra.dev/docs/agents) for per-client setup.

Upgrading from 1.x? Run `nifra upgrade 2.0.0` as a dry-run, then follow the
[Nifra 2.0 migration guide](https://nifra.dev/docs/migrate-2).

## Install

```sh
bun add @nifrajs/core            # the lean server + router
bun add @nifrajs/client          # the typed client (browser-safe)
bun add @nifrajs/schema          # the `t` schema builder + OpenAPI (optional)
bun add @nifrajs/middleware      # CORS, security headers, rate limiting (optional)
```

Nifra is **ESM-only** and **Bun-native** (it uses `Bun.serve`). It runs on Bun; the client is environment-agnostic.

Use `@nifrajs/core` (or `@nifrajs/core/server`) for the ordinary HTTP runtime. Nifra keeps the package
root deliberately lean and splits everything else across documented subpaths - most apps only ever touch
a handful, so start with those and reach for the rest when a concept actually comes up:

- **Everyday** - `@nifrajs/core/server` (the runtime), `.../contract` (`defineContract` + `implement`),
  `.../router`, `.../cookies`, plus `@nifrajs/schema` (the `t` builder) and `@nifrajs/client` (the typed
  client). This is the 80% API.
- **Advanced, opt in when you need it** - `.../assurance`, `.../capabilities`, `.../idempotency`,
  `.../effect-ledger`, `.../durable-execution`, `.../causality`, `.../classification`, `.../manifest`,
  `.../reflection`, `.../diff`, `.../mcp`, `.../sse`, `.../webhook`, `.../budget`, `.../seo`, `.../mount`. Each is a separate documented
  subpath, so you never pay (in bundle size or in concepts to learn) for one you don't import.

## Validate input with `t` (and get OpenAPI for free)

`@nifrajs/schema`'s `t` is a TypeBox-backed builder: it validates at the request boundary *and* - because a TypeBox schema **is** a JSON Schema - generates OpenAPI with no extra work. Bring your own [Standard Schema][standard-schema] (zod, valibot, arktype) too; they validate identically.

```ts
import { server } from "@nifrajs/core/server"
import { t, toOpenAPI } from "@nifrajs/schema"

const app = server().post("/users", { body: t.object({ name: t.string() }) }, (c) => ({
  id: "u1",
  name: c.body.name, // typed as string, validated at runtime
}))

const openapi = toOpenAPI(app) // OpenAPI 3.1 document
```

Invalid bodies are rejected with a structured `422` before your handler runs.

## Graduate to a contract - handlers unchanged

When you want a decoupled, versionable API surface, lift the same routes into a contract. Handlers written inline lift over **unchanged**.

```ts
import { defineContract, implement } from "@nifrajs/core/contract"
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

The client can now be built from the **contract** alone (`client(contract, url)`) - no dependency on the server's source. This is the shape agents reference: `nifra context` emits the live contract; `nifra check` enforces it.

## Harden it

```ts
import { server } from "@nifrajs/core/server"
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

Middleware is table stakes. What's different here: three CI gates that turn security posture into build failures.

**`nifra assure` - every route proves its policy.** A `nifra.assurance.ts` file classifies every route by reflection (no request-path cost) and fails CI naming exactly what evidence is missing - authentication on a write, a rate limit, CSRF, a body cap:

```sh
$ nifra assure
✖ POST /notes (authenticated-write) is missing nifra.authenticated
```

**`nifra capabilities check` - routes can't reach effects they didn't declare.** Routes declare effect tokens (`{ capabilities: ["db.write"] }`); the check compares what a route *says* against what its module graph can actually *reach*, and pins the result in a deterministic `capabilities.lock.json`. A `GET` that can reach a domain write is an error, unconditionally. Crash-sensitive effects graduate to durable execution - journaled intent/outcome, typed sagas with compensation, and operator-resolved ambiguity instead of ever replaying an unknown effect.

**`nifra manifest diff` - a deploy can't silently widen the surface.** `nifra manifest emit` folds contracts, assurance, effects, and field-level response sensitivity (`classified(schema, "pii")`) into one deterministic, hash-verified artifact; the diff fails closed on breaking contracts, lost assurance, expanded effects, or newly exposed sensitive fields. Sign it with Ed25519 via your KMS if you promote artifacts between environments.

Full detail: [Security & hardening](site/routes/docs/security.tsx) · [Effect provenance](site/routes/docs/capabilities.tsx) · [Verification ladder](site/routes/docs/verification.tsx)

## Runs on the edge, too

Bun is the first-class runtime (`app.listen()`), but the whole lifecycle is `app.fetch(Request): Promise<Response>` with zero Bun APIs - so the same `app` deploys to **Cloudflare Workers** (`export default app`), **Deno** (`Deno.serve(app.fetch)`), or **Node** (via the [`@nifrajs/node`](packages/node) adapter). See [Deployment](site/routes/docs/deployment.tsx) and [Edge & bindings](site/routes/docs/edge.tsx).

## Principles (enforced, not aspirational)

- **Reject invalid input at three boundaries** - compile-time (types), boot-time (config throws loudly), request-time (Standard Schema → structured `422`). "Genuine fallback" is a documented whitelist; everything else rejects.
- **Tests everywhere, six kinds** - unit, type-level (`*.test-d.ts`), property/fuzz, mode-conformance, benchmark-regression, security-guardrail.
- **Speed is a measured goal** - tracked with the `oha` HTTP matrix (`bun run bench:http`) across Bun, Node, and Deno against raw runtime handlers plus representative API framework baselines.
- **Production-grade by default** - graceful shutdown, redacting logs, idempotent guards, integer-money discipline; nothing is "we'll fix it later".

## Packages

| Package | What it is |
|---|---|
| [`@nifrajs/core`](packages/core) | Router, fully-inferred server, contracts, lifecycle middleware, hardening |
| [`@nifrajs/client`](packages/client) | End-to-end-typed, never-throwing client (Eden-style proxy) |
| [`@nifrajs/schema`](packages/schema) | TypeBox-backed `t` builder + `toOpenAPI` |
| [`@nifrajs/middleware`](packages/middleware) | CORS, security headers, rate limiting |
| [`@nifrajs/testing`](packages/testing) | Contract-derived hostile inputs, response conformance, runtime matrices, test sessions |
| [`@nifrajs/node`](packages/node) | Run a Nifra app on Node's `http` server (opt-in) |
| [`@nifrajs/cli`](packages/cli) | `nifra check`, `nifra context`, `nifra mcp` - the agent toolchain |

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
bun run bench:http     # oha HTTP matrix across Bun/Node/Deno
```

MIT licensed.

[standard-schema]: https://standardschema.dev
