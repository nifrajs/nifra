# @nifrajs/storage

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

### Minor Changes

- af27cb5: feat(storage): add `@nifrajs/storage` — blob storage with pluggable adapters

  One `StorageAdapter` interface (`put` / `get` / `delete` / `exists` / `list`) with three adapters:
  `MemoryStorage` (dev/tests), `FileStorage` (local disk, traversal-safe), and `R2Storage` (Cloudflare R2,
  binding typed structurally — no `@cloudflare/workers-types`). The persistence half of `@nifrajs/uploads`.
  Every adapter rejects unsafe keys (absolute, `..` traversal, NUL, backslash) via `assertSafeKey`, so a
  `FileStorage` key can't escape its root and keys are portable across adapters. Dependency-free; implement
  `StorageAdapter` for S3/GCS.
