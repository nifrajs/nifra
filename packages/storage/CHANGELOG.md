# @nifrajs/storage

## 2.3.0

### Minor Changes

- e8aeab9: Cache, queue and storage operations can produce capability evidence.

  ```ts
  import { useCapability } from "@nifrajs/core/capabilities";

  const cache = createCache({ beacon: useCapability });
  await cache.for(c).set(key, value); // announces `cache.write`, and fails closed if undeclared
  ```

  Static provenance answers what a MODULE can reach, so its evidence is as broad as the module holding
  it. A call answers which ROUTE did what. That is the gap these close: the token is produced by the
  operation rather than by a policy file asserting an import implies it.

  `useCapability` is passed in rather than imported, so all three packages keep their zero dependencies -
  a cache should not pull the server into a bundle that only wanted a cache. Nothing changes for existing
  code: the unbound `cache.set(...)`, `job.enqueue(...)` and `adapter.put(...)` paths are untouched, and
  `for(context)` without a configured beacon throws rather than handing back something that quietly
  produces no evidence.

  Storage takes a `withCapabilityBeacon(adapter, { beacon })` wrapper instead of an interface method,
  because `StorageAdapter` is meant to be implemented outside the package and a new method would break
  every adapter already written. `cache.wrap` announces read AND write, since a miss writes and which one
  happens is not knowable before the call.

## 2.2.0

## 2.1.0

## 2.0.0

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

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

### Minor Changes

- af27cb5: feat(storage): add `@nifrajs/storage` — blob storage with pluggable adapters

  One `StorageAdapter` interface (`put` / `get` / `delete` / `exists` / `list`) with three adapters:
  `MemoryStorage` (dev/tests), `FileStorage` (local disk, traversal-safe), and `R2Storage` (Cloudflare R2,
  binding typed structurally — no `@cloudflare/workers-types`). The persistence half of `@nifrajs/uploads`.
  Every adapter rejects unsafe keys (absolute, `..` traversal, NUL, backslash) via `assertSafeKey`, so a
  `FileStorage` key can't escape its root and keys are portable across adapters. Dependency-free; implement
  `StorageAdapter` for S3/GCS.
