# @nifrajs/graphql

Mount a GraphQL endpoint on a nifra app. A spec-compliant [GraphQL-over-HTTP](https://graphql.github.io/graphql-over-http/draft/) handler, `graphql-transport-ws` subscriptions over nifra's native WebSocket lane, and your typed nifra context piped straight into resolvers.

It executes with the `graphql` package's own `parse`/`validate`/`execute`/`subscribe` - no HTTP framework is re-bundled, the request body reuses core's single bounded, prototype-guarded trust boundary, and the query text is never logged.

## Install

```bash
bun add @nifrajs/graphql graphql
# subscriptions also need:
bun add graphql-ws
```

`graphql` is a required peer; `graphql-ws` is optional (only for subscriptions).

## Queries and mutations

```ts
import { server } from "@nifrajs/core"
import { mountGraphql } from "@nifrajs/graphql"
import { buildSchema } from "graphql"

const schema = buildSchema(`
  type Query { hello: String }
  type Mutation { echo(msg: String!): String }
`)

const rootValue = {
  hello: () => "world",
  echo: ({ msg }: { msg: string }) => msg,
}

const app = server()
mountGraphql(app, { schema, rootValue })
// POST /graphql  - queries + mutations
// GET  /graphql  - queries only (idempotent, cacheable)
```

Prefer the handler directly? Mount it yourself:

```ts
import { respondGraphql } from "@nifrajs/graphql"

app.post("/graphql", (c) => respondGraphql(c.req, { schema, rootValue }))
```

## Context injection

The one thing a plain third-party mount cannot do: derive the resolver `contextValue` from what your nifra handler already resolved (auth subject, env, params).

```ts
mountGraphql(app, {
  schema,
  context: ({ request, nifra }) => ({
    user: nifra?.env,           // nifra route context, when mounted via mountGraphql
    ip: request.headers.get("x-forwarded-for"),
  }),
})
```

Resolvers read it as their third argument.

## Subscriptions

Subscriptions run over the same route via `graphql-transport-ws`. Bring a subscription source - the bundled in-memory `createPubSub` is the reference implementation; swap in a durable bus (Redis, a Durable Object, NATS) that exposes the same `{ publish, subscribe }` shape for multi-instance deploys.

```ts
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { mountGraphql, createPubSub } from "@nifrajs/graphql"

const pubsub = createPubSub<number>()

const app = server().use(websocket())
mountGraphql(app, {
  schema,
  context: () => ({ pubsub }),
  subscriptions: true,
})

// A resolver:
//   count: { subscribe: (_, __, ctx) => ctx.pubsub.subscribe("count"), resolve: (n) => n }
// Push an event from anywhere:
pubsub.publish("count", 1)
```

The route must negotiate the `graphql-transport-ws` subprotocol at the WebSocket layer for a browser `graphql-ws` client to connect.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `schema` | - | Executable `GraphQLSchema` (required). |
| `context` | `{}` | Build the resolver `contextValue` per operation. |
| `rootValue` | - | Root value passed to the executor. |
| `maxBodyBytes` | `1_000_000` | Request body cap; larger bodies answer 413. |
| `protoPoisoning` | `"reject"` | Prototype-pollution policy for the JSON body. |
| `allowedOrigins` | reflect `*` | CORS origin allowlist. |
| `authorize` | - | Per-request guard; return `false` for 401. |
| `enableGet` | `true` | Serve `GET /graphql` (queries only). |
| `subscriptions` | `false` | `true` (reuse schema/context) or explicit WS options. |
| `legacyJsonResponse` | `false` | Old always-200 `application/json` shape. |

## Responses

By default responses use the `application/graphql-response+json` media type with spec status codes: `200` for an executed result (including field errors in `errors`), `400` for a parse or validation failure, `401` for a rejected `authorize`, `405` for a mutation attempted over GET. Set `legacyJsonResponse: true` for the older always-`200` `application/json` behavior some clients expect.

## License

MIT

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
