<p align="center">
  <a href="https://nifra.dev"><img src="site/public/logo-mark.png" alt="Nifra" width="88"></a>
</p>

<h1 align="center">Nifra</h1>

<p align="center"><b>The AI-native TypeScript framework.</b><br>
Typed APIs and full-stack SSR on five UI libraries, one app across Bun, Node, Deno, and the edge -<br>
built so both humans and coding agents can change it safely.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nifrajs/core"><img src="https://img.shields.io/npm/v/@nifrajs/core?label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/@nifrajs/core"><img src="https://img.shields.io/npm/dm/@nifrajs/core?label=downloads" alt="downloads"></a>
  <a href="https://github.com/nifrajs/nifra/actions/workflows/ci.yml"><img src="https://github.com/nifrajs/nifra/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%3E%3D1.3-000?logo=bun" alt="Bun >= 1.3"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
</p>

<p align="center">
  <a href="https://nifra.dev/docs">Documentation</a> ·
  <a href="https://nifra.dev/play">Playground</a> ·
  <a href="https://nifra.dev/benchmarks">Benchmarks</a> ·
  <a href="https://nifra.dev/docs/comparison">vs. other frameworks</a>
</p>

---

Most code is now written with an AI agent in the loop - and agents drift. They call an endpoint that moved, expect a response shape that changed, or hand-roll `fetch` with types that rot. Nifra removes that class of bug at the framework level: the client is inferred from the server's TypeScript (drift is a compile error), the docs are a live MCP server (agents read the real API, not stale memory), and a route-assurance gate fails the build when any route - human- or agent-written - ships without its required security evidence.

## Quick start

```sh
bun create nifra my-app            # full-stack app: pick framework, runtime, DB, auth, CI
```

or start with just a typed API:

```sh
bun add @nifrajs/core @nifrajs/schema @nifrajs/client
```

## The core loop

Routes are typed automatically from their path literals, handler context, and return values. Add a
Standard Schema when you need runtime validation/coercion or an explicit request/response contract:

```ts
// server.ts
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id })) // params + response inferred from the route
  .post("/users", { body: t.object({ name: t.string() }) }, (c) => {
    // c.body is validated + typed - invalid input is a structured 422 before this runs
    return { id: crypto.randomUUID(), name: c.body.name }
  })
  .listen(3000)
```

```ts
// anywhere.ts - fully typed from the server, zero codegen
import { client } from "@nifrajs/client"
import type { app } from "./server"

const api = client<typeof app>("http://localhost:3000")

const res = await api.users({ id: "42" }).get()
if (res.ok) res.data.id     // typed from the route - tsc fails the moment the route changes
else res.error              // failures are returned, never thrown
```

Change a route and every caller stops compiling until it's updated. That one property is what keeps agent-edited codebases correct. For a decoupled, versionable surface, use [`defineContract` + `implement`](https://nifra.dev/docs/contract).

## Agent-native, by construction

Register the MCP server and any coding agent reads your live routes, fetches version-checked examples, runs real requests against the app it just edited, and gates its own drift:

```sh
claude mcp add nifra -- bunx nifra mcp     # Claude Code (Cursor/VS Code: same command in mcp.json)
nifra init-agents                          # or: write .mcp.json + AGENTS.md + CLAUDE.md for you
```

The loop covers live project context and routes, verified docs/examples/types, checks with structured
fixes, real requests and SSR renders, request inspection, tests, assurance, and verification levels.
`nifra_context` and `nifra_example` are version-aware; `nifra_run`, `nifra_render`, and
`nifra_inspect` verify what the edited app actually does; `nifra_check` and `nifra_assure` close the
drift and security gates. [Full tool list →](https://nifra.dev/docs/agents)

Agents that read skills get the conventions too - the same four skills on every surface:

```sh
pi install npm:@nifrajs/skills                                     # Pi
/plugin marketplace add nifrajs/nifra && /plugin install nifra@nifra  # Claude Code
```

Not in a Nifra repo? The docs tools are also hosted - add `https://mcp.nifra.dev` to Claude, Cursor, or ChatGPT and it learns Nifra from the same verified corpora, no checkout. One MCP, two transports (the same hosted-plus-local pairing Supabase, Stripe, and GitHub use): project tools run only on your machine over stdio - **your code never reaches our servers**.

### Build and host agents

The same public contracts also cover applications that are agent products:

| Use case | Packages | What it provides |
|---|---|---|
| Bounded agent turns | [agent](packages/agent) | Typed tools, budgets, approvals, resumable token-only evidence, token streaming, and shared run state. Model, storage, and policy stay injected ports. |
| Coding-agent host | [coding-agent](packages/coding-agent) · [agent-protocol](packages/agent-protocol) · [pi](packages/pi) | A standalone nifra-agent host with sessions, workflows, extensions, post-turn verification with bounded automatic repair, native approval events/resolution, local RPC, and an optional Pi backend. |
| Browser and desktop UI | [agent-app](packages/agent-app) · [runner](packages/runner) · [apps/workbench](apps/workbench) | Content-free negotiated views, ordered/resumable event handling, capability registry, decision inbox, Run Studio projections, and structured in-process request runs. |
| Protocol bridges | [a2a](packages/a2a) · [ag-ui](packages/ag-ui) | A2A 1.0 JSON-RPC/SSE and AG-UI SSE endpoints over the same agent runner, including typed human-in-the-loop resume. |
| Observability and skills | [agent-telemetry](packages/agent-telemetry) · [skills](packages/skills) | Token-only OpenTelemetry run traces and portable skills that keep agents pointed at the live MCP contract. |

   bun add @nifrajs/coding-agent @nifrajs/pi
    bunx nifra-agent --backend pi --message "run the checks and explain failures" \
      --verify-after-turn check --max-repair-attempts 2

Provider credentials, durable state, authorization, and approval policy are application ports rather
than hidden framework state. The local process adapter contains crashes and accidents but is **not** a
hostile-code sandbox; use OS-level isolation for untrusted code. A2A and AG-UI mounts likewise require
the host application to add authentication and authorization at its route boundary.

## Proof, not promises

Three CI gates turn security posture into build failures:

```sh
$ nifra assure
✖ POST /notes (authenticated-write) is missing nifra.authenticated
```

- **`nifra assure`** - a policy file classifies every route by reflection and fails CI naming exactly what evidence is missing: authentication on a write, a rate limit, CSRF, a body cap. No other framework ships this.
- **`nifra capabilities check`** - routes declare effect tokens (`{ capabilities: ["db.write"] }`); the check compares what a route *says* against what its module graph can actually *reach*, pinned in a lockfile. A `GET` that can reach a domain write is an error.
- **`nifra manifest diff`** - one hash-verified artifact of contracts + assurance + effects + response sensitivity; deploy promotion fails closed on breaking contracts, lost assurance, or newly exposed sensitive fields.

[Security & hardening →](https://nifra.dev/docs/security) · [Effect provenance →](https://nifra.dev/docs/capabilities) · [Verification ladder →](https://nifra.dev/docs/verification)

## Full-stack, five UI libraries

The same routes, loaders, actions, streaming SSR, `defer()`/`<Await>` progressive rendering, islands,
and typed data layer work on **React, Vue, Solid, Svelte, or Preact** - switching is one adapter
import, not a rewrite. File routing, SSG/ISR, progressive-enhancement forms, query cache, and server
functions whose bodies never ship to the browser.

```sh
bun create nifra my-app --framework svelte   # or react | vue | solid | preact
```

[Frameworks →](https://nifra.dev/docs/frameworks) · [Rendering →](https://nifra.dev/docs/rendering) · [Server functions →](https://nifra.dev/docs/server-functions)

## StyleX and Tailwind migration

Nifra includes a conservative Tailwind → StyleX codemod for static JSX class lists:

```sh
nifra migrate --from tailwind --to stylex          # inspect the proposed changes
nifra migrate --from tailwind --to stylex --write  # apply safe changes
```

The codemod rewrites supported `className="..."` attributes to `stylex.props(...)` and a local
`stylex.create(...)` table. It understands responsive breakpoints and element-local pseudo-classes.
Dynamic class expressions, arbitrary values, parent-dependent variants, and unknown utilities are
left untouched with file/line diagnostics for manual review. Use `--dir <path>` to scan a subdirectory.

StyleX compilation is built into Nifra's Bun pipeline. Install the runtime and optional compiler peers,
then register both browser and SSR transforms in `nifra.config.ts`:

```sh
bun add @stylexjs/stylex
bun add -d @babel/core @stylexjs/babel-plugin @babel/plugin-syntax-flow \
  @babel/plugin-syntax-jsx @babel/plugin-syntax-typescript
```

```ts
import { stylexBunPlugin } from "@nifrajs/web/plugins/stylex"

export const clientPlugins = [stylexBunPlugin("dom")]
export const serverPlugins = [stylexBunPlugin("ssr")]
```

The same adapter also exposes `stylexVite()` for projects whose transforms intentionally run through
Vite. See the [StyleX migration guide](https://nifra.dev/docs/cli#tailwind-to-stylex) for the complete
setup and supported-syntax details.

## One app, every runtime

The whole lifecycle is `app.fetch(Request): Promise<Response>` - Bun first-class, and the same app deploys to Node (`@nifrajs/node`), Deno, Cloudflare Workers, and Vercel Edge with one line of adapter code. [Deployment →](https://nifra.dev/docs/deployment)

Measured, published, reproducible ([methodology + every row, including the ones we lose](https://nifra.dev/benchmarks)):

- **Bun:** ~131k req/s - 101% of the raw-runtime ceiling, level-to-ahead of Elysia
- **Node:** ahead of Fastify by ~12% on the validated POST (96% of the raw-Node ceiling), tie on GET
- **SSR:** React rendered per-request at ~25x Next.js throughput on the same machine

Run it yourself: `bun run bench:http` · `bun run bench:ssr`

## Batteries (53 packages, all typed, all optional)

| | |
|---|---|
| Core | [`core`](packages/core) router + server · [`client`](packages/client) typed client · [`schema`](packages/schema) validation + OpenAPI · [`middleware`](packages/middleware) CORS/headers/rate-limit |
| Full-stack | [`web`](packages/web) SSR core · `web-react` / `web-vue` / `web-solid` / `web-svelte` / `web-preact` adapters |
| App services | [`auth`](packages/auth) · [`jobs`](packages/jobs) · [`cron`](packages/cron) · [`cache`](packages/cache) · [`storage`](packages/storage) · [`uploads`](packages/uploads) · [`image`](packages/image) · [`i18n`](packages/i18n) · [`env`](packages/env) · [`content`](packages/content) |
| Quality | [`testing`](packages/testing) contract-derived tests · [`mock`](packages/mock) contract mocks · [`otel`](packages/otel) tracing · [`devtools`](packages/devtools) |
| Agents | [`cli`](packages/cli) the `nifra` toolchain · [`mcp`](packages/mcp) build MCP servers · [`prompt`](packages/prompt) schema-validated LLM output · [`skills`](packages/skills) portable agent skills · [`runner`](packages/runner) structured app runs |
| Agent runtime | [`agent`](packages/agent) bounded turns · [`agent-protocol`](packages/agent-protocol) versioned sessions/events · [`agent-app`](packages/agent-app) content-free browser views · [`agent-telemetry`](packages/agent-telemetry) OTel traces |
| Agent host & protocols | [`coding-agent`](packages/coding-agent) host/CLI · [`pi`](packages/pi) Pi adapter · [`a2a`](packages/a2a) A2A bridge · [`ag-ui`](packages/ag-ui) AG-UI bridge |

Every package documents its own surface; the root stays lean and everything advanced is an opt-in subpath, so you never pay for a concept you don't import. [All packages →](https://nifra.dev/docs)

## Principles (enforced, not aspirational)

- **Reject invalid input at three boundaries** - compile-time, boot-time, request-time (structured `422`).
- **Speed is a measured goal** - benchmark-regression tests; the published matrix is regenerated, not curated.
- **Production-grade by default** - graceful shutdown, redacting logs, idempotent guards; nothing is "we'll fix it later".
- **Docs cannot lie** - examples are compiled against the live API in CI; the MCP corpus regenerates from built packages.

## Develop

```sh
bun install
bun run check          # lint + typecheck (incl. type-level tests) + tests with coverage
bun run build          # emit dist/ (js + d.ts) for all packages
bun run bench:http     # the oha HTTP matrix across Bun/Node/Deno
```

Contributions welcome - see [CONTRIBUTING.md](CONTRIBUTING.md). Upgrading from 1.x: [migration guide](https://nifra.dev/docs/migrate-2).

MIT licensed.
