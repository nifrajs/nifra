# @nifrajs/otel

## 1.8.0

## 1.7.0

## 1.6.0

### Minor Changes

- d228ac4: `ActiveObservation.setAttributes(attributes)` — merge attributes onto the in-flight request span from a handler or later plugin (`c.observation.setAttributes({ "tenant.key": ... })`), for facts learned mid-request (authenticated principal, flag bucket, cache verdict). Silently a no-op once the observation has ended; the exported span stays immutable.

## 1.5.0

### Patch Changes

- bd3433f: Security + correctness hardening: `FileStorage` refuses paths that cross symbolic links (component-wise `lstat` walk + `O_NOFOLLOW` writes; `list()` skips symlinks) so a planted symlink can no longer redirect reads/writes outside the storage root. OTel spans no longer copy raw `Error.message` into exported attributes (exception text routinely carries credentials/URLs); spans record `error.recorded: true` instead. New `onResponseFinalized` terminal observer on the server (`Middleware.onResponseFinalized` / `ResponseFinalization`) runs after every transforming `onResponse` hook and is fail-open — tracing now records the true final status even when a later hook rewrites or throws. OpenAPI generation sanitizes URI-style `$id` values into valid component names/`$ref` pointers (hex-derived, collision-suffixed) and is immune to `__proto__` key pollution.

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

### Patch Changes

- Updated dependencies [f1f0e18]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/core@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/core@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/core@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- @nifrajs/core@0.1.0-beta.2
