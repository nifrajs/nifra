---
"@nifrajs/core": minor
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
  serialization, durable terminal states are monotonic, and unmatched effect spans have bounded retention.
