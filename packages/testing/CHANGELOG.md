# @nifrajs/testing

## 2.7.0

### Patch Changes

- @nifrajs/client@2.7.0
- @nifrajs/core@2.7.0
- @nifrajs/mock@2.7.0

## 2.6.1

### Patch Changes

- Updated dependencies [5840c98]
  - @nifrajs/core@2.6.1
  - @nifrajs/client@2.6.1
  - @nifrajs/mock@2.6.1

## 2.6.0

### Patch Changes

- Updated dependencies [e6349e5]
  - @nifrajs/core@2.6.0
  - @nifrajs/client@2.6.0
  - @nifrajs/mock@2.6.0

## 2.5.0

### Minor Changes

- 31ccc27: The adversarial laboratory and the mock server now recognize zod automatically - no wiring. Every Standard Schema carries a `"~standard".vendor` tag, so when a body/query/response validator says "zod" and zod (4+) is installed, the new `autoReflectJsonSchema` default (exported from `@nifrajs/mock`) converts it via `z.toJSONSchema` exactly as the `@nifrajs/testing/zod` bridge does. Out of the box, zod routes now get synthesized witnesses and constraint-driven mutations in `runAdversarialContract`/`assertAdversarialContract` instead of NO_WITNESS, and `createMockServer` returns real data instead of `{}`. zod stays an optional peer, loaded lazily and probed once; a project without zod (or with a schema zod cannot convert) keeps today's opaque behavior. An explicit `reflectJsonSchema` hook always overrides the default - pass `() => undefined` to force everything opaque.

### Patch Changes

- Updated dependencies [31ccc27]
- Updated dependencies [da7f2d5]
  - @nifrajs/mock@2.5.0
  - @nifrajs/client@2.5.0
  - @nifrajs/core@2.5.0

## 2.4.0

### Minor Changes

- 06f4aaa: Contract tooling works out of the box for validators that expose no JSON Schema (zod, valibot, arktype).

  `runAdversarialContract` / `assertAdversarialContract` and `createMockServer` accept a `reflectJsonSchema` hook that derives an inspectable JSON Schema from an opaque Standard Schema validator. With it, zod routes get synthesized witnesses and constraint-driven mutations (min/max, length, pattern, enum, format) instead of a `NO_WITNESS` gap, and mocked responses carry real data instead of `{}`. A ready-made zod bridge ships as `@nifrajs/testing/zod` (`zodJsonSchema`); `zod` is an optional peer, so only projects that import that subpath need it installed. The adversarial report also gains an `advisories` list that flags when `validateResponses` is on but no route declares a `response` schema, making silently-zero response coverage visible.

### Patch Changes

- Updated dependencies [138bfba]
- Updated dependencies [06f4aaa]
  - @nifrajs/core@2.4.0
  - @nifrajs/mock@2.4.0
  - @nifrajs/client@2.4.0

## 2.3.0

### Patch Changes

- Updated dependencies [6f5b3ad]
- Updated dependencies [85b354d]
- Updated dependencies [9b110b9]
- Updated dependencies [8514caa]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [b271164]
- Updated dependencies [8c77d47]
- Updated dependencies [ea0a27f]
- Updated dependencies [5fe332a]
- Updated dependencies [c823915]
- Updated dependencies [d2840ac]
  - @nifrajs/core@2.3.0
  - @nifrajs/client@2.3.0
  - @nifrajs/mock@2.3.0

## 2.2.0

### Patch Changes

- Updated dependencies [5f460db]
- Updated dependencies [e713cab]
- Updated dependencies [a4645e2]
- Updated dependencies [6aa0aac]
  - @nifrajs/core@2.2.0
  - @nifrajs/client@2.2.0
  - @nifrajs/mock@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [bd294bb]
- Updated dependencies [d3aac63]
  - @nifrajs/core@2.1.0
  - @nifrajs/client@2.1.0
  - @nifrajs/mock@2.1.0

## 2.0.0

### Patch Changes

- b7017b9: Map `@nifrajs/testing/certification` in the workspace TypeScript paths, so the subpath resolves from
  source like every other first-party entry instead of only through built declarations.
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [d91a45b]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0
  - @nifrajs/client@2.0.0
  - @nifrajs/mock@2.0.0

## 1.13.0

### Patch Changes

- Updated dependencies [aae8614]
- Updated dependencies [5b6127a]
  - @nifrajs/core@1.13.0
  - @nifrajs/client@1.13.0
  - @nifrajs/mock@1.13.0

## 1.12.0

### Minor Changes

- 63d3845: Add bounded execution-causality contracts and propagation, OpenTelemetry causal links, event-envelope lineage, and a deterministic durable failure laboratory. `nifra levels` L4 now uses the deep adversarial contract engine through its explicitly isolated executor. Also add hash-verifiable adapter certification profiles and duplicate physical Nifra/React install detection in `nifra doctor`/`nifra check`.

### Patch Changes

- Updated dependencies [63d3845]
- Updated dependencies [246f498]
  - @nifrajs/core@1.12.0
  - @nifrajs/client@1.12.0
  - @nifrajs/mock@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [2dde7e5]
- Updated dependencies [279f80c]
- Updated dependencies [5638ada]
- Updated dependencies [279f80c]
  - @nifrajs/core@1.11.0
  - @nifrajs/client@1.11.0
  - @nifrajs/mock@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [92181be]
- Updated dependencies [3773f0a]
- Updated dependencies [92181be]
  - @nifrajs/core@1.10.0
  - @nifrajs/client@1.10.0
  - @nifrajs/mock@1.10.0

## 1.9.1

### Patch Changes

- @nifrajs/client@1.9.1
- @nifrajs/core@1.9.1
- @nifrajs/mock@1.9.1

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
- eeb6075: Add incident → regression: turn a failed request into a committed test - the one thing a generic error
  tracker (Sentry/PostHog) can't do, because it needs the framework's contract + in-process replay.
  `captureIncident(request, response)` records a request + observed response; `replayIncident` /
  `assertIncidentReplays` re-run it against the CURRENT app and assert the response contract (status, and
  optionally shape) still reproduces; `generateRegressionTest` emits a committable `.test.ts`. In-memory
  replay uses the real captured inputs (exact, no leak); the emitted fixture redacts request string values
  BY DEFAULT behind a sanitize banner, so a committed test never carries PII/secrets. This complements
  error tracking - it does not store incidents or replace observability.

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

- acb9e97: feat(testing): add `@nifrajs/testing` - cookie-aware in-process test sessions

  `@nifrajs/client`'s `testClient` already drives an app's `fetch` with end-to-end types (no server, port,
  or network). This adds what it doesn't: a `cookieJar()` and a cookie-persisting `testSession(app)`, so a
  login → authenticated-request flow tests as easily as a single request - `Set-Cookie` is captured and the
  `Cookie` header is sent automatically across calls (honouring `Max-Age=0` / past `Expires` for logout).
  Same typed in-process client; the only addition is a shared cookie jar.

### Patch Changes

- @nifrajs/client@1.1.0
