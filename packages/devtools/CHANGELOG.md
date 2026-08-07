# @nifrajs/devtools

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

### Minor Changes

- 795357f: DevTools' request-trace buffer is now queryable, not just streamable.

  Alongside the live SSE overlay, the plugin serves a one-shot JSON snapshot at `/_nifra/devtools/state` - the recent request traces (method, path, status, duration, ISR status, response bytes), filterable by a `path` prefix and a `limit`, and guarded exactly like the stream (loopback-only unless `allowRemote`, origin-checked, optional `authorize` hook). A new `filterDevToolsEvents` export defines that query once, shared by the endpoint and its consumers.

  `nifra_inspect` (MCP) reads that snapshot for a running dev server, so an agent can SEE what its requests actually did - which route answered, the status, how long, ISR hit or miss - instead of inferring it from the response alone. It needs the app to mount the `devtools()` plugin (which auto-enables in development).

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

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.
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
