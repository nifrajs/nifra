# @nifrajs/storage

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

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

### Patch Changes

- cee03d7: The beacon wrapper stops breaking adapters that use `#private` fields, and the `--db` sample no longer
  collides with a template route.

  A `#` field's brand check is per-instance, so a Proxy that passes itself as the receiver throws
  `Cannot access invalid private field`. Getters broke on both views and methods broke on the unbound
  one - an adapter using `#` worked unwrapped and broke the moment you added beacons. Both proxies now
  read against the target, and the unbound one binds methods to it.

  The generated `db/read-routes.ts` registered `GET /notes`, which the fullstack template already
  registers. `nifra check` associates modules with routes by matching the registered path across your
  source, so that unmerged sample lent its `db.read` reach to a template route that never touches the
  database - failing the check on a fresh `create-nifra --template fullstack --db …`. The sample uses
  `/db/notes` now, and says why.

- 389861b: `withCapabilityBeacon` no longer deletes an adapter's optional capabilities.

  It assembled its return value from five hand-listed methods, so wrapping a presignable or movable
  adapter silently dropped `presign`, `listPage`, `copy` and `move`. A certified S3 adapter came back
  unable to sign a URL - no error, no option, and `presign` is the method most worth beaconing, since a
  PUT URL hands out write access.

  Forwarding is now by Proxy, which cannot miss a method by construction, and the wrapper is generic so
  the wrapped type keeps its extensions. `presign` announces read or write by its `operation` argument;
  `listPage` reads; `copy` and `move` write; a method nobody mapped announces write, because a
  declaration says what a route MAY do and an unmapped extension should fail closed against a read-only
  route rather than slip through unannounced.

- ea0a27f: The beacon wrapper survives a frozen adapter, and file writes cannot be raced onto a symlink.

  A Proxy may not report a different value for a non-writable, non-configurable own property, so wrapping
  a frozen adapter whose methods are own properties threw a Proxy invariant error before the wrapper
  could run - measured, not theorised. The beacon now proxies an extensible facade and delegates every
  read, write and call to the real instance, so `instanceof`, `#private` brands and frozen adapters all
  keep working. Methods are cached per wrapper, so repeated property reads keep their identity and
  allocate once.

  `FileStorage` opened its target with `O_TRUNC` after checking the path, which leaves a window between
  the check and the open: winning it pointed the descriptor at a file outside the storage root and
  truncated it. The open no longer truncates. The descriptor is compared against the path's current inode
  and its resolved location is confirmed to be inside the root, and only then is anything destroyed.

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

- bd3433f: Security + correctness hardening: `FileStorage` refuses paths that cross symbolic links (component-wise `lstat` walk + `O_NOFOLLOW` writes; `list()` skips symlinks) so a planted symlink can no longer redirect reads/writes outside the storage root. OTel spans no longer copy raw `Error.message` into exported attributes (exception text routinely carries credentials/URLs); spans record `error.recorded: true` instead. New `onResponseFinalized` terminal observer on the server (`Middleware.onResponseFinalized` / `ResponseFinalization`) runs after every transforming `onResponse` hook and is fail-open - tracing now records the true final status even when a later hook rewrites or throws. OpenAPI generation sanitizes URI-style `$id` values into valid component names/`$ref` pointers (hex-derived, collision-suffixed) and is immune to `__proto__` key pollution.

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

- af27cb5: feat(storage): add `@nifrajs/storage` - blob storage with pluggable adapters

  One `StorageAdapter` interface (`put` / `get` / `delete` / `exists` / `list`) with three adapters:
  `MemoryStorage` (dev/tests), `FileStorage` (local disk, traversal-safe), and `R2Storage` (Cloudflare R2,
  binding typed structurally - no `@cloudflare/workers-types`). The persistence half of `@nifrajs/uploads`.
  Every adapter rejects unsafe keys (absolute, `..` traversal, NUL, backslash) via `assertSafeKey`, so a
  `FileStorage` key can't escape its root and keys are portable across adapters. Dependency-free; implement
  `StorageAdapter` for S3/GCS.
