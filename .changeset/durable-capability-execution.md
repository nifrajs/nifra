---
"@nifrajs/core": minor
"@nifrajs/client": minor
"@nifrajs/web": minor
"@nifrajs/otel": minor
---

Add `executeCapability()` as a correlated, policy-aware effect boundary.

- Correlate intent and terminal evidence with a random `effectId`, record committed/failed outcomes
  automatically, and combine request cancellation with bounded async `aroundCapability()` admission
  policies while preserving the synchronous `useCapability()` path.
- Retain idempotency results for every completed response, including non-2xx outcomes, so a retry
  cannot repeat an effect that succeeded before a later handler failure.
- Add durable approval, effect journal, saga/compensation, and reconciliation primitives behind the
  `durable-execution` subpath, plus token-only OpenTelemetry effect spans from `@nifrajs/otel/effects`.
  Reconciliation supports bounded cursor pages, approval resume tokens stay out of ordinary error
  serialization, durable terminal states are monotonic, crash ambiguity has an effect-ID-bound operator
  resolution API, and unmatched effect spans have bounded retention.
- Add one shared owned-effect scope across capabilities, saga execution, compensation, idempotency
  evidence, durable transitions, and telemetry. An explicit `markIdempotencySafeToRetry()` outcome
  releases a resolved 5xx only while the scope proves no effect began.
- Add negotiated, versioned transport codecs with bounded plain-JSON and rich-wire adapters for HTTP,
  the typed client, loader NDJSON, and WebSocket frames.
- Add Postgres, SQLite, and Durable Object durable-execution adapters with one reusable conformance
  suite, plus leased reconciliation workers with bounded pages/concurrency, durable cursors, filters,
  cancellation, backpressure, and token-only metrics.
