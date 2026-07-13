# @nifrajs/testing

## 1.9.0

### Patch Changes

- Updated dependencies [03cd76f]
- Updated dependencies [03cd76f]
  - @nifrajs/core@1.9.0
  - @nifrajs/client@1.9.0
  - @nifrajs/mock@1.9.0

## 1.8.0

### Minor Changes

- 6b375fc: Add a deterministic contract laboratory that synthesizes valid request witnesses, proves hostile
  mutations invalid with each route's own Standard Schema validator, checks boundary rejection across a
  runtime matrix, validates declared success responses, shrinks failures, and retains replay seeds.
- eeb6075: Add incident → regression: turn a failed request into a committed test — the one thing a generic error
  tracker (Sentry/PostHog) can't do, because it needs the framework's contract + in-process replay.
  `captureIncident(request, response)` records a request + observed response; `replayIncident` /
  `assertIncidentReplays` re-run it against the CURRENT app and assert the response contract (status, and
  optionally shape) still reproduces; `generateRegressionTest` emits a committable `.test.ts`. In-memory
  replay uses the real captured inputs (exact, no leak); the emitted fixture redacts request string values
  BY DEFAULT behind a sanitize banner, so a committed test never carries PII/secrets. This complements
  error tracking — it does not store incidents or replace observability.

### Patch Changes

- Updated dependencies [e47c4c5]
  - @nifrajs/core@1.8.0
  - @nifrajs/client@1.8.0
  - @nifrajs/mock@1.8.0

## 1.7.0

### Patch Changes

- @nifrajs/client@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/client@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [70aa836]
  - @nifrajs/client@1.5.0

## 1.4.0

### Patch Changes

- @nifrajs/client@1.4.0

## 1.3.1

### Patch Changes

- @nifrajs/client@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies [4a4b1c4]
  - @nifrajs/client@1.3.0

## 1.2.2

### Patch Changes

- @nifrajs/client@1.2.2

## 1.2.1

### Patch Changes

- @nifrajs/client@1.2.1

## 1.2.0

### Patch Changes

- @nifrajs/client@1.2.0

## 1.1.0

### Minor Changes

- acb9e97: feat(testing): add `@nifrajs/testing` — cookie-aware in-process test sessions

  `@nifrajs/client`'s `testClient` already drives an app's `fetch` with end-to-end types (no server, port,
  or network). This adds what it doesn't: a `cookieJar()` and a cookie-persisting `testSession(app)`, so a
  login → authenticated-request flow tests as easily as a single request — `Set-Cookie` is captured and the
  `Cookie` header is sent automatically across calls (honouring `Max-Age=0` / past `Expires` for logout).
  Same typed in-process client; the only addition is a shared cookie jar.

### Patch Changes

- @nifrajs/client@1.1.0
