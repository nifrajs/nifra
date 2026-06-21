# @nifrajs/core

The Bun-native, contract-first HTTP framework at the heart of [nifra](../../README.md):
a radix router, a fully type-inferred server, versionable contracts, lifecycle
middleware, and production hardening.

```sh
bun add @nifrajs/core
```

```ts
import { server } from "@nifrajs/core"

const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: nameSchema }, (c) => ({ created: c.body.name }))
  .listen(3000)

export type App = typeof app // hand this to @nifrajs/client for end-to-end types
```

- **Inline or contract-first.** Write routes inline (types inferred from the
  builder), or `defineContract(...)` + `implement(...)` for a decoupled, versionable
  surface — handlers lift over unchanged.
- **Validation at the boundary.** Per-route `body`/`query` is any
  [Standard Schema](https://standardschema.dev) (zod/valibot/arktype, or `@nifrajs/schema`'s
  `t`); invalid input is rejected with a structured `400` before the handler runs.
- **Lifecycle middleware.** `derive`/`decorate` extend the typed context;
  `onRequest`/`beforeHandle`/`afterHandle`/`onResponse`/`onError` run around handlers;
  `use(middleware)` applies a bundle.
- **Hardening built in.** `stop({ drainMs })` graceful shutdown (+ opt-in SIGTERM/
  SIGINT), `requestTimeoutMs` (+ `ctx.signal`), a streaming body-size cap, and a
  redacting structured `Logger`.

ESM-only; requires Bun at runtime. MIT.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
