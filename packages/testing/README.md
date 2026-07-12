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
request for each declared response schema, so use an isolated test app/database—never point the
laboratory at production.

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

Same in-process client as `testClient` — the app's own `fetch`, no server/port/network, the full real
lifecycle (validation, middleware, contracts, auth) and end-to-end types from `App`. The only addition is
that every call carries and captures cookies via a shared jar.

## API

- `assertAdversarialContract(app, options?)` → green report or throws `AdversarialContractError`.
- `runAdversarialContract(app, options?)` → structured `{ ok, results, failures, gaps, seed }` report.
- `testSession<App>(app, { origin?, cookies? })` → `{ client: Treaty<App>, cookies: CookieJar }`.
- `cookieJar()` → `CookieJar` — `header()` · `applyTo(headers)` · `store(response)` · `set` · `get` · `clear` · `size`.
  Honours removal (`Max-Age=0` / past `Expires`); other cookie attributes are ignored (in-process, same-origin).

For a **stateless** request (no cookies), use `testClient` from `@nifrajs/client` directly.
