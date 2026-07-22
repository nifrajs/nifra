# @nifrajs/core

The Bun-native, contract-first HTTP framework at the heart of [nifra](../../README.md):
a radix router, a fully type-inferred server, versionable contracts, lifecycle
middleware, and production hardening.

```sh
bun add @nifrajs/core
```

```ts
import { server } from "@nifrajs/core/server"

const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: nameSchema }, (c) => ({ created: c.body.name }))
  .listen(3000)

export type App = typeof app // hand this to @nifrajs/client for end-to-end types
```

`@nifrajs/core` and `@nifrajs/core/server` expose the same lean common runtime. Optional systems are
available only from their explicit subpaths, so an ordinary HTTP server never evaluates them:

```ts
import { defineContract, implement } from "@nifrajs/core/contract"
import { startCausality } from "@nifrajs/core/causality"
import { defineAssurancePolicy } from "@nifrajs/core/assurance"
```

- **Inline or contract-first.** Write routes inline (types inferred from the
  builder), or `defineContract(...)` + `implement(...)` for a decoupled, versionable
  surface — handlers lift over unchanged.
- **Validation at the boundary.** Per-route `body`/`query` is any
  [Standard Schema](https://standardschema.dev) (zod/valibot/arktype, or `@nifrajs/schema`'s
  `t`); invalid input is rejected with a structured `422` before the handler runs.
- **Lifecycle middleware.** `derive`/`decorate` extend the typed context;
  `onRequest`/`beforeHandle`/`afterHandle`/`onResponse`/`onError` run around handlers;
  `use(middleware)` applies a bundle.
- **Hardening built in.** `stop({ drainMs })` graceful shutdown (+ opt-in SIGTERM/
  SIGINT), `requestTimeoutMs` (+ `ctx.signal` and `ctx.budget`), a streaming body-size cap, and a
  redacting structured `Logger`.
- **One request budget.** `ctx.budget` carries the admitted absolute deadline and monotonic
  `remaining()` time. An inbound `x-nifra-deadline` can only shorten `requestTimeoutMs`/
  `maxInboundDeadlineMs`; malformed and expired values fail before the handler. `ctx.signal`
  remains the cancellation primitive and aborts at that same effective deadline.
- **Route assurance.** Official auth, CSRF, body-limit, rate-limit, idempotency,
  IP-restriction, and security-header modules publish reflection-safe enforcement evidence.
  An ordered `AssurancePolicy` classifies every route and fails closed on missing or forbidden
  evidence without adding work to the request path.
- **Owned effect execution.** `executeCapability()` correlates intent and terminal evidence with an
  opaque `effectId`, records outcomes automatically, and forwards request cancellation. Add
  order-scoped `aroundCapability()` policies for async approval/admission; they receive token-only
  metadata, have bounded timeouts, and must call `next()` exactly once before the effect can run.
- **Durable workflows (opt in).** `@nifrajs/core/durable-execution` provides tenant/principal-bound,
  signed single-use approval resumes; a durable effect journal + reconciliation scanner; and a typed
  saga state machine with reverse compensation, retry/backoff, and ambiguous-crash detection. Production
  constructors reject stores that do not declare `durability: "durable"`. Operational scans use bounded
  cursor pages through `reconcileEffectsPage()` / `reconcileSagasPage()`.
- **Rich wire values (opt in).** `@nifrajs/core/wire` round-trips dates, bigints, maps, sets, binary,
  shared references, and cycles through JSON transports. Decoding validates every reachable shape,
  preserves owned `__proto__` keys without prototype mutation, and enforces configurable node, depth,
  collection-entry, and decoded-byte limits.

```ts
import { defineAssurancePolicy, evaluateRouteAssurance, NIFRA_ASSURANCE } from "@nifrajs/core/assurance"

const policy = defineAssurancePolicy({
  rules: [
    { name: "health", match: { paths: ["/health"] }, require: [] },
    { name: "mutation", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] },
      require: [NIFRA_ASSURANCE.AUTHENTICATED, NIFRA_ASSURANCE.CSRF] },
    { name: "read", match: { methods: ["GET", "HEAD"] },
      require: [NIFRA_ASSURANCE.AUTHENTICATED] },
  ],
})

evaluateRouteAssurance(app, policy).ok // pure reflection-time evaluation
```

ESM-only; requires Bun at runtime. MIT.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
