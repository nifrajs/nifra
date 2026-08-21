# @nifrajs/testing

Contract-derived adversarial testing and stateful in-process helpers for Nifra apps.

## Contract laboratory

`assertAdversarialContract` turns the schemas already registered on an app into executable tests. It:

- synthesizes a valid **contract witness** from inspectable JSON Schema;
- makes small nested **hostile mutations** and sends only values the route's own Standard Schema
  validator has proved invalid after HTTP transport normalization;
- expects rejection at the real request boundary (422 by default);
- executes a valid witness and validates the real success body against `response`;
- runs the same stable case IDs across a Bun/Node/Workers runtime matrix; and
- retains a replay seed and greedily shrinks unexpected acceptance failures.

```ts
import { test } from "bun:test"
import { assertAdversarialContract } from "@nifrajs/testing"
import { app } from "../src/app"

test("the API contract withstands hostile inputs", async () => {
  await assertAdversarialContract(app, {
    seed: 73,
    prepareRequest(request) {
      const headers = new Headers(request.headers)
      headers.set("authorization", "Bearer test-session")
      return new Request(request, { headers })
    },
  })
})
```

Nifra's `t` schemas carry JSON Schema, so witnesses are automatic. Standard Schema deliberately does
not require introspection; for an opaque Zod/Valibot/ArkType schema, provide only its known-good values:

```ts
await assertAdversarialContract(app, {
  witnesses: {
    "POST /users/:id": {
      params: { id: "user-1" },
      body: { name: "Ada" },
      query: { notify: "true" },
    },
  },
})
```

The validator still decides which generated mutations are truly invalid; the supplied witness does not
weaken validation. A missing/invalid witness is a coverage gap, not a silent pass. Set
`requireCoverage: false` only when gaps are intentionally advisory.

To exercise adapter parity, pass runtime fetch targets. The reflected `app` remains the one source of
the contract:

```ts
const report = await assertAdversarialContract(app, {
  runtimes: [
    { name: "bun", fetch: (request) => bunApp.fetch(request) },
    { name: "node", fetch: (request) => nodeAdapter.fetch(request) },
    { name: "worker", fetch: (request) => worker.fetch(request, env) },
  ],
})
```

`runAdversarialContract` returns the same structured report without throwing. Every failure includes
`replay: { seed, caseId, runtime }`; rerun one case with `only: caseId`. Contract runs execute one valid
request for each declared response schema, so use an isolated test app/database-never point the
laboratory at production.

### Opaque validators (zod / valibot / arktype)

A `t` schema exposes JSON Schema, so witnesses and constraint-driven mutations are synthesized
automatically. A Standard Schema validator that carries no JSON Schema (zod, valibot, arktype) validates
requests fine, but the laboratory can't inspect it - those routes report `NO_WITNESS` and get only
type-confusion mutations. Pass `reflectJsonSchema` to convert such a validator; for zod, use the shipped
bridge:

```ts
import { zodJsonSchema } from "@nifrajs/testing/zod"

await assertAdversarialContract(app, { reflectJsonSchema: zodJsonSchema })
```

This turns on witness synthesis and constraint-driven mutations (min/max, length, pattern, enum, format)
for zod routes. `createMockServer` from `@nifrajs/mock` accepts the same hook. `zod` is an optional peer -
only projects that import `@nifrajs/testing/zod` need it installed.

### Response conformance needs a declared contract

Response conformance only runs for routes that declare a `response` schema. A response type inferred from a
handler's return is a client-side contract the laboratory cannot see, so an app that declares none checks
zero response targets even with `validateResponses` on - the report surfaces this in `advisories`. Declare
`response:` on the routes you want verified. (Runtime response validation in the server itself is a
separate opt-in, installed by the `responseContract()` plugin.)

`nifra levels` L4 uses this same deep engine through the explicitly configured isolated executor;
the older core invariant runner remains only as a compatibility export.

## Durable failure laboratory

`createFailureLab` injects replayable failures at named seams in a disposable test adapter. It
supports crash-after-commit, duplicate delivery, event reordering, virtual delay, budget expiry,
lost provider replies, and checkpoint contention. It never sleeps and its evidence records only
the schedule tokens - not requests, events, provider results, error messages, or stacks.

```ts
import { FailureInjectedError, runFailureScenario } from "@nifrajs/testing"

let committed = false
const report = await runFailureScenario({
  name: "outbox-crash-after-commit",
  execute(lab) {
    committed = true // the real disposable transaction committed
    lab.checkpoint("outbox.after_commit")
  },
  verify: ({ error }) => committed && error instanceof FailureInjectedError,
}, {
  seed: 73,
  schedule: [{ kind: "crash", point: "outbox.after_commit" }],
})

expect(report.ok).toBe(true)
// Re-run with report.replay.seed + report.replay.schedule.
```

Use `lab.deliveries()` around a relay batch, `lab.provider()` around a provider call,
`lab.remaining()` before a deadline-bound hop, and `lab.checkpointContended()` at a projection CAS.
The laboratory is a test port: production code does not import it and pays no hot-path cost.

## Adapter certification

`@nifrajs/testing/certification` turns an adapter interface into portable, hash-verifiable evidence.
Built-in profiles cover storage (including optional paging/signing/copy-move), cache, jobs, Node/Deno-
style runtimes, and durable event delivery. Every check receives a fresh adapter, capability status is
explicit, and failures retain only the error class - never provider messages or credentials.

```ts
import {
  certifyAdapter,
  storageAdapterCertificationProfile,
  verifyAdapterCertification,
} from "@nifrajs/testing/certification"

const report = await certifyAdapter({
  profile: storageAdapterCertificationProfile({ paging: true, presign: true, move: true }),
  adapterId: "s3-production-shape",
  createAdapter: () => createDisposableS3Adapter(),
})

if (!report.ok || !(await verifyAdapterCertification(report))) throw new Error("adapter uncertified")
```

Run profiles only against disposable namespaces. The certification module is structural and
dependency-free, so adapter packages keep it in test/CI and acquire no production runtime dependency.

## Stateful sessions

[`@nifrajs/client`](../client)'s **`testClient`** is already the typed, no-network in-process request
client (Nifra's supertest / `inject`). `testSession` adds a **cookie jar**, so a login → authenticated
request flow tests as easily as a single request.

```ts
import { testSession } from "@nifrajs/testing"
import { app } from "../src/app"

const { client, cookies } = testSession<typeof app>(app)

await client.auth.login.post({ email, password }) // Set-Cookie captured into the jar
const me = await client.me.get()                   // Cookie sent automatically
expect(me.ok && me.data.id).toBeDefined()
expect(cookies.get("sid")).toBeDefined()           // inspect the jar

await client.auth.logout.post()                    // a Max-Age=0 Set-Cookie clears it
expect(cookies.get("sid")).toBeUndefined()
```

Same in-process client as `testClient` - the app's own `fetch`, no server/port/network, the full real
lifecycle (validation, middleware, contracts, auth) and end-to-end types from `App`. The only addition is
that every call carries and captures cookies via a shared jar.

## API

- `assertAdversarialContract(app, options?)` → green report or throws `AdversarialContractError`.
- `runAdversarialContract(app, options?)` → structured `{ ok, results, failures, gaps, seed }` report.
- `createFailureLab(options)` → deterministic controller for isolated durable adapters.
- `runFailureScenario(scenario, options)` → token-only `{ ok, replay, evidence, error? }` report.
- `certifyAdapter({ profile, adapterId, createAdapter })` → capability matrix + SHA-256 evidence.
- `verifyAdapterCertification(report)` → recompute and verify portable certification evidence.
- `testSession<App>(app, { origin?, cookies? })` → `{ client: Treaty<App>, cookies: CookieJar }`.
- `cookieJar()` → `CookieJar` - `header()` · `applyTo(headers)` · `store(response)` · `set` · `get` · `clear` · `size`.
  Honours removal (`Max-Age=0` / past `Expires`); other cookie attributes are ignored (in-process, same-origin).
- `proveIdempotency({ run, runs? })` → a token-only proof that canonical effect ledgers replay identically.

For a **stateless** request (no cookies), use `testClient` from `@nifrajs/client` directly.

### Agent evaluation and failure matrix

`runAgentEvalComposition` composes trajectory replay, fault profiles, contract invariants,
idempotency proofs, and adapter certification. Reports expose explicit invariant and rubric cases,
stable regression IDs, schedule tokens, and digests; they do not retain prompts, tool payloads,
model output, labels, or a single opaque quality score. The failure matrix covers model, tool,
approval, cancellation, lease, cursor, registry, and deployment boundaries.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
