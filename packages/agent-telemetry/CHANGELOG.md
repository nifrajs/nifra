# @nifrajs/agent-telemetry

## 4.0.2

### Patch Changes

- @nifrajs/otel@4.0.2

## 4.0.1

### Patch Changes

- @nifrajs/otel@4.0.1

## 4.0.0

### Patch Changes

- Updated dependencies [dde125b]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [d7892ea]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [ac703a1]
- Updated dependencies [e1b89c0]
- Updated dependencies [1afbe9f]
- Updated dependencies [50e68d9]
- Updated dependencies [b8af5cf]
- Updated dependencies [6d87951]
- Updated dependencies [76b7aa8]
- Updated dependencies [6d20355]
- Updated dependencies [6907cbe]
- Updated dependencies [b64c3ee]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/core@4.0.0
  - @nifrajs/otel@4.0.0

## 3.5.0

### Patch Changes

- @nifrajs/otel@3.5.0

## 3.4.0

### Patch Changes

- @nifrajs/otel@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/otel@3.3.0

## 3.2.0

### Minor Changes

- 893f7b3: Agent-run tracing and composable telemetry ports.

  `@nifrajs/agent-telemetry` gains `traceAgentRun`: one OpenTelemetry span per bounded agent run, one
  child span per step evidence item, with tool names, effect ids, error codes, and effect-ledger heads
  as span attributes. Only the runner's constrained token-only evidence is exported; telemetry is
  fail-open and can never fail the turn it observes.

  `@nifrajs/agent` gains `combineAgentTelemetry` to fan one run's step evidence out to several
  telemetry ports. The HTTP seams - `mountAgent`, the A2A adapter, and the AG-UI adapter - now compose
  their SSE evidence stream with a caller-injected telemetry port instead of replacing it.

### Patch Changes

- @nifrajs/otel@3.2.0

## 3.1.0

### Patch Changes

- @nifrajs/otel@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [f0fd370]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0
  - @nifrajs/otel@3.0.0

## 2.14.1

### Patch Changes

- @nifrajs/otel@2.14.1

## 2.14.0

### Patch Changes

- @nifrajs/otel@2.14.0

## 2.13.0

### Patch Changes

- @nifrajs/otel@2.13.0

## 2.12.1

### Patch Changes

- @nifrajs/otel@2.12.1

## 2.12.0

### Patch Changes

- Updated dependencies [0efacea]
- Updated dependencies [9a9346e]
  - @nifrajs/otel@2.12.0

## 2.11.0

### Patch Changes

- @nifrajs/otel@2.11.0

## 2.10.0

### Patch Changes

- @nifrajs/otel@2.10.0

## 2.9.1

### Patch Changes

- @nifrajs/otel@2.9.1

## 2.9.0

### Patch Changes

- @nifrajs/otel@2.9.0

## 2.8.2

### Patch Changes

- @nifrajs/otel@2.8.2

## 2.8.1

### Patch Changes

- @nifrajs/otel@2.8.1

## 2.8.0

### Patch Changes

- @nifrajs/otel@2.8.0

## 2.7.1

### Patch Changes

- @nifrajs/otel@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/otel@2.7.0

## 2.6.1

### Patch Changes

- @nifrajs/otel@2.6.1

## 2.6.0

### Patch Changes

- @nifrajs/otel@2.6.0

## 2.5.0

### Patch Changes

- @nifrajs/otel@2.5.0

## 2.4.0

### Patch Changes

- @nifrajs/otel@2.4.0

## 2.3.0

### Patch Changes

- @nifrajs/otel@2.3.0

## 2.2.0

### Patch Changes

- @nifrajs/otel@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [bd294bb]
  - @nifrajs/otel@2.1.0

## 2.0.0

### Major Changes

- d91a45b: Remove Nifra's remaining deprecated and compatibility-only public surfaces for the 2.0 cutover.

  - `@nifrajs/core` and `nifra` now expose only the lean HTTP server API at their package roots. Import
    optional systems from their documented subpaths. The deprecated invariant runner and the
    `@nifrajs/budget` compatibility package are removed; use `@nifrajs/testing` and
    `@nifrajs/core/budget` respectively.
  - Web redirects accept only an options object as their second argument, the prerender enumeration
    wrapper is removed in favor of `enumerateStaticRoutes()`, and fragment navigation resolves IDs only.
  - MCP Apps metadata uses only `_meta.ui.resourceUri`; the deprecated flat `ui/resourceUri` key is gone.
  - Telemetry uses `ObservationAdapter` directly; the `AgentSpan`, `AgentSpanExporter`, and `SpanExporter`
    aliases are removed.
  - Invalid HTTP method overrides always fail closed with 400; the legacy ignore mode is removed.
  - `nifra build` always emits a complete target deploy directory and defaults to Bun. The old
    client-only build branch is removed; `nifra start` runs the generated Bun `server.js`.

### Patch Changes

- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [bc46cc9]
- Updated dependencies [1522d06]
- Updated dependencies [d91a45b]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0
  - @nifrajs/otel@2.0.0

## 1.13.0

### Patch Changes

- @nifrajs/otel@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [63d3845]
  - @nifrajs/otel@1.12.0

## 1.11.0

### Patch Changes

- @nifrajs/otel@1.11.0

## 1.10.0

### Patch Changes

- @nifrajs/otel@1.10.0

## 1.9.1

### Patch Changes

- @nifrajs/otel@1.9.1

## 1.9.0

### Patch Changes

- @nifrajs/otel@1.9.0

## 1.8.0

### Patch Changes

- @nifrajs/otel@1.8.0

## 1.7.0

### Patch Changes

- @nifrajs/otel@1.7.0

## 1.6.0

### Patch Changes

- Updated dependencies [d228ac4]
  - @nifrajs/otel@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [bd3433f]
  - @nifrajs/otel@1.5.0

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

### Patch Changes

- Updated dependencies [4d25970]
  - @nifrajs/otel@1.4.0
