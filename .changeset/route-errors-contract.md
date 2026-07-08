---
"@nifrajs/core": minor
"@nifrajs/schema": minor
"@nifrajs/web": minor
"@nifrajs/client": minor
---

feat: `errors` response contract on routes + typed client error bodies

A route's `RouteSchema` may now declare `errors` — a `{ status → Standard Schema }` map of its failure modes.
Like `response`, it's a compile-time + introspection contract (not validated at runtime, zero hot-path cost):
the declared error bodies flow into OpenAPI as non-2xx `responses` and into the `/llms.txt` context, so
tooling and coding agents can read the *whole* contract, not just the happy path.

The **typed client** now surfaces them: on a failure `Result`, `data` is the parsed error body typed from the
route's `errors` (a union across declared statuses; `unknown` when none declared), discriminated by `ok`.
`error` remains the normalized `{ error, issues }` summary. The **decoupled contract client**
(`client(contract, url)`) gets the same treatment — its failure `data` is typed from the op's non-2xx
`responses` schemas.

**Behavior change:** on failure, `data` is now the parsed error response body (previously always `null`) — so
`const { ok, data } = await api.orders.post(...)` gives you the typed error body in the `!ok` branch. `data`
is still `null` only on a transport error (status `0`, no response).
