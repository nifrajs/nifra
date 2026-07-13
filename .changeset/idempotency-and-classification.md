---
"@nifrajs/core": minor
---

Add a request idempotency primitive and response data-classification tags.

`schema.idempotency` dedupes retries of a mutating route on an `Idempotency-Key` header: the first
request runs and its response is stored, a retry with the same key replays that response without
re-running the handler, a key reused with a different body is rejected (409), a missing key fails
closed (400), and only successful responses are cached (an error releases the key so a retry can
proceed). Ships an in-memory `IdempotencyStore` with an injectable clock; a durable store implements
the same interface. Declaring idempotency also satisfies the capability-assurance idempotency
requirement for a write capability (`durable` scope additionally clears the durable-command
requirement). Routes without it keep the existing hot path unchanged.

`schema.classification` declares the highest data-sensitivity a route's response carries
(`public` | `pii` | `secret`) — a declarative, compile-time + introspection fact, never enforced at
runtime. It is reflected for tooling and recorded in the capability lockfile, so a route that starts
returning PII becomes a reviewable change.
