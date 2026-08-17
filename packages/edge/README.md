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
server({ maxBodyBytes: 256_000, protoPoisoning: "strip" })
```

| Option | Default | What |
| --- | --- | --- |
| `maxBodyBytes` | `1_000_000` | body-size cap before a `413`, matching core |
| `protoPoisoning` | `"reject"` | `__proto__` policy for JSON bodies: `"reject"` \| `"strip"` \| `"ignore"`, matching core |

## Security

The body trust boundary is on by default and imported from `@nifrajs/core` - the same lane the full Server runs, so there is one implementation, never a trimmed copy that could drift. On every body-bearing route it enforces:

| Guard | Effect |
| --- | --- |
| Streaming byte cap | a length-less (chunked) body is drained under `maxBodyBytes`; once over, the stream is **cancelled** and rejected `413` - it is never buffered whole |
| Content-Length pre-reject | a declared length over `maxBodyBytes` is `413` before a byte is read; a malformed length is `400` |
| Prototype-pollution guard | an own `__proto__` key (or a poisoning-shaped `constructor.prototype`) in a JSON body is rejected (`"reject"`, default) or removed (`"strip"`) before it reaches your handler |
| Media-type framing | JSON and urlencoded bodies are framed and capped; other content types get `415` |

Rejection envelopes are byte-for-byte the full Server's.

**Whether you need this depends on the runtime:**

- **Stream runtimes** (Cloudflare Workers, Deno Deploy, Bun): the runtime hands your worker a live request stream with no size ceiling below its own memory limit. A single length-less request into an unguarded `.json()` buffers unbounded and can cross the isolate memory limit (~128 MB on Workers) - one request, one killed worker (and on auto-scaling platforms, a metered bill). Here the byte cap is **load-bearing**, not optional.
- **Pre-capped serverless** (Vercel Edge ~4.5 MB, AWS API Gateway 6-10 MB, GCP 10-32 MB, Azure ~30 MB default): the platform already bounds the body at its edge, so the crash case is largely its job. The cap still earns its place by tightening that platform ceiling to your app's real intent and returning a consistent `413`. (Platform limits are documented ceilings - check current docs for your plan.)

The prototype-pollution guard is **platform-independent**: no runtime guards `JSON.parse` for you, and a `__proto__`-bearing object becomes pollution the moment downstream code merges it. The guard stops it at ingress. Both defenses tune via [Options](#options).

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
