---
"@nifrajs/testing": minor
---

Add incident → regression: turn a failed request into a committed test — the one thing a generic error
tracker (Sentry/PostHog) can't do, because it needs the framework's contract + in-process replay.
`captureIncident(request, response)` records a request + observed response; `replayIncident` /
`assertIncidentReplays` re-run it against the CURRENT app and assert the response contract (status, and
optionally shape) still reproduces; `generateRegressionTest` emits a committable `.test.ts`. In-memory
replay uses the real captured inputs (exact, no leak); the emitted fixture redacts request string values
BY DEFAULT behind a sanitize banner, so a committed test never carries PII/secrets. This complements
error tracking — it does not store incidents or replace observability.
