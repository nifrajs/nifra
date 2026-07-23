# @nifrajs/agent-telemetry

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
