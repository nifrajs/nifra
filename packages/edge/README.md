# @nifrajs/edge

Compact fetch-handler server for edge and serverless runtimes - Cloudflare Workers, Vercel Edge, Deno Deploy, Bun. Keeps the `server().get().post()` DX and the full request trust boundary (bounded body read, Content-Length pre-reject, prototype-pollution guard, JSON / urlencoded framing) in a fraction of the bundle. Zero runtime dependencies beyond `@nifrajs/core`.

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.

## Why

`@nifrajs/core`'s `server()` carries lifecycle hooks, cookies, response contracts, deadlines, WebSockets, and a plugin system. On an edge worker you often want none of that - just typed routing and a safe body. `@nifrajs/edge` is that subset: the same routing DX, the *same* body trust boundary (imported from core, never re-derived, so there is no second copy of the security contract to drift), and nothing else.

The rejection envelopes are byte-for-byte the full Server's - so an app can start on `@nifrajs/edge` and graduate to `@nifrajs/core`'s `server()` without its clients noticing.

## Install

```sh
bun add @nifrajs/edge @nifrajs/core
```

## Use

```ts
// worker.ts
import { server, type StandardSchemaV1 } from "@nifrajs/edge"

const createUser: StandardSchemaV1<{ name: string; age: number }> = /* zod, valibot, arktype, ... */

const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: createUser }, (c) => ({ created: c.body.name, age: c.body.age }))

export default app // { fetch } - a module worker handler
```

`c.params` is typed from the route pattern. `c.body` is narrowed to the schema's output. Return a value (rendered as JSON) or a `Response` for full control. Throw a `Response` for an early exit; any other throw becomes a flat `500`.

## Context

| Member | What |
| --- | --- |
| `c.request` | the raw `Request` |
| `c.params` | path params, typed from the pattern (`/users/:id` -> `{ id: string }`) |
| `c.body` | parsed, schema-validated body (`undefined` on a body-less route) |
| `c.query()` | query string parsed to an object, on demand |
| `c.header(name)` | a request header (case-insensitive), or `null` |

## Options

```ts
server({ maxBodyBytes: 256_000, protoPoisoning: "sanitize" })
```

| Option | Default | What |
| --- | --- | --- |
| `maxBodyBytes` | `1_000_000` | body-size cap before a `413`, matching core |
| `protoPoisoning` | `"reject"` | `__proto__` policy for JSON bodies, matching core |

## Not included

By design: no lifecycle / `around` hooks, cookies, response contracts, deadlines, WebSockets, or plugins. Reach for `@nifrajs/core`'s `server()` when an app needs those.

## License

MIT

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
