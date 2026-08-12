---
name: nifra
description: Use when writing, reviewing, or debugging code in a Nifra project (@nifrajs/* packages, `nifra` CLI, server()/defineContract, loaders and actions, file routes under routes/). Explains how to reach Nifra's live MCP tools so signatures come from the installed version instead of memory, and which sibling skill to load for API, full-stack, or verification work.
metadata:
  homepage: https://nifra.dev
  docs: https://nifra.dev/docs
---

# Nifra

Nifra is a Bun-native, contract-first, framework-agnostic full-stack TypeScript framework. One schema
drives runtime validation, TypeScript types, the typed client, and OpenAPI. The whole lifecycle is
`app.fetch(Request): Promise<Response>`, so one app runs on Bun, Node, Deno, Cloudflare Workers, and
Vercel Edge.

## Rule zero: do not write Nifra from memory

Nifra ships a verified MCP server. Its answers are typechecked against the version installed in the
project you are editing, so they beat recall. Prefer it over guessing an API, and over reading
`node_modules/@nifrajs/**/*.d.ts`.

If the project already has `.mcp.json` or `.cursor/mcp.json`, the server is registered. If not:

```sh
bunx @nifrajs/cli init-agents      # writes .mcp.json, .cursor/mcp.json, AGENTS.md, CLAUDE.md
```

Not inside a Nifra project (answering a question, comparing frameworks, writing a snippet)? The docs
tools are hosted at `https://mcp.nifra.dev` - same corpus, no checkout.

Tools worth knowing, in the order you usually need them:

| Tool | Use it for |
|---|---|
| `nifra_context` | This project's live route index, schemas, and conventions. Call first in unfamiliar code. |
| `nifra_docs` | The prose doc for a concept, pinned to the installed version. |
| `nifra_example` | A snippet that compiled against this version in CI. Never hand-write what this returns. |
| `nifra_types` | The exact TypeScript of any `@nifrajs/*` symbol. |
| `nifra_run` | Execute a real request against the app in-process to check behaviour. |
| `nifra_check` | The done-gate. See `nifra-verify`. |
| `nifra_assure` | Per-route security evidence. See `nifra-verify`. |

No MCP available at all? Fall back to `https://nifra.dev/llms.txt` (index) or
`https://nifra.dev/llms-full.txt` (every doc page inlined), and to each package's `LLM.md` contract
card in `node_modules/@nifrajs/<pkg>/LLM.md`.

## The core loop

```ts
// server.ts
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: t.object({ name: t.string() }) }, (c) => {
    // c.body is validated and typed - invalid input became a structured 422 before this ran
    return { id: crypto.randomUUID(), name: c.body.name }
  })
  .listen(3000)
```

```ts
// anywhere.ts - inferred from the server, zero codegen
import { client } from "@nifrajs/client"
import type { app } from "./server"

const api = client<typeof app>("http://localhost:3000")

const res = await api.users({ id: "42" }).get()
if (res.ok) res.data.id  // typed from the route
else res.error           // failures are returned, never thrown
```

Change a route and every caller stops compiling. That property is the point: it is what keeps an
agent-edited codebase correct.

## Non-negotiables when you edit a Nifra project

1. **Never hand-roll `fetch()` against this app's own API.** Use the typed client. `nifra check`
   fails the build on hand-rolled calls, and it is right to.
2. **Validate at the boundary, not in the handler.** Put the schema in the route options so invalid
   input is a `422` before your code runs.
3. **Failures are returned, not thrown.** Client results are `{ ok, data } | { ok: false, error }`.
   Do not wrap client calls in try/catch expecting a throw.
4. **Server-only code stays out of `routes/`.** A `node:` or native import reaching the client bundle
   is a build error, not a warning.
5. **Run the gate before you claim done.** `nifra check` (or the `nifra_check` tool). A failing check
   means the work is not finished.

## Which skill next

- Typed JSON APIs, schemas, contracts, middleware, the client -> load `nifra-api`.
- File routes, loaders, actions, SSR, islands, React/Vue/Solid/Svelte/Preact -> load `nifra-web`.
- `nifra check`, `nifra assure`, capabilities, the manifest, CI gates -> load `nifra-verify`.

## Starting from scratch

```sh
bun create nifra my-app                       # full-stack: pick framework, runtime, DB, auth, CI
bun create nifra my-app --framework svelte    # react | vue | solid | preact | svelte
bun add @nifrajs/core @nifrajs/schema @nifrajs/client   # just a typed API
```
