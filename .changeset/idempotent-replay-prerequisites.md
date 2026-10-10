---
"@nifrajs/core": patch
"@nifrajs/client": patch
"@nifrajs/graphql": patch
---

Recheck current route authentication, authorization and prerequisite hooks before idempotent replay,
without repeating the handler, effect ledger or stored response transformations. Preserve stored
status, safe headers and the replay marker after admission.

Enforce typed SSE event limits in UTF-8 bytes before dispatch for complete and fragmented frames,
with bounded, linear fragment accounting independent of chunk boundaries.

Bound the in-memory GraphQL pubsub subscriber queue to 1024 events by default. Overloaded subscribers
detach and fail with `GraphqlPubSubOverflowError`; configure `maxQueuedEvents` or explicit
`drop-oldest`/`drop-newest` policies when needed. Returning or throwing into an iterator clears queued
events and ends delivery.
