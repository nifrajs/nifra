# @nifrajs/cache

## 5.10.0

No changes in this release.

## 5.9.0

No changes in this release.

## 5.8.0

No changes in this release.

## 5.7.0

No changes in this release.

## 5.6.0

No changes in this release.

## 5.5.1

No changes in this release.

## 5.5.0

No changes in this release.

## 5.4.0

No changes in this release.

## 5.3.0

### Patch Changes

- 7ab9692: Add build-time schema compilation that emits typed static validators without runtime code generation. Generated modules preserve strict validation and structured issues while avoiding the schema builder and dynamic compiler in deployed bundles.
  
  A schema whose property key, `format` name or custom kind holds a quote, backslash or line break, or whose literal holds a backslash or line break, now validates on the eval-free checker and is refused by build-time compilation. TypeBox splices that text into generated source unescaped, so a quote could end the string and run the rest as code.
  
  Prepare immutable route modules and layout chains in production while executing authorization gates and loaders for every request. Mutable manifests can disable module preparation with `cacheRouteModules: false`.
  
  Reduce output projection bookkeeping for uniform subtrees, reuse request-bound cache views, and record completed cache spans without allocating an active observation. Span parentage, sampling, redaction, exporter isolation, and capability enforcement remain intact.
  
  Keep custom start-only `ObservationLifecycle` implementations compatible. The factory returns the extended `RecordingObservationLifecycle` interface with the new `record` method.
  
  Mark the migration parser's TypeScript keyword-kind comparison as syntax, so the security check does not mistake it for a secret comparison.
- 7fa40da: `cache.set` now waits for a `wrap` load's store write already sent for the same key, as `delete`, `invalidateTag` and `clear` do. Withdrawal only stopped a load that had not yet written, so with an async store that applies requests out of order an older loaded value could land after, and overwrite, a newer `set`.

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.

## 5.0.0

### Minor Changes

- dd0e530: `CacheStore` gains two optional methods for a store that several caches or processes share: `fence(key, tags)` and `setIfFence(key, entry, tags, token)`. A `wrap` load takes a fence before its loader runs and stores its result through `setIfFence`, which refuses the write when a `set` or `delete` of the key, an `invalidateTag` of one of its tags, or a `clear` ran in the meantime from any cache sharing the store. `MemoryCache` implements both, so two caches over one `MemoryCache` no longer write back a value the other invalidated.

  A `delete`, `invalidateTag` or `clear` now runs after the cache's own async store writes it covers, so a store that applies requests out of order cannot land an earlier write after the invalidation.

  `cacheStoreCertificationProfile({ fencing: true })` adds the `fenced-write` capability, which checks a store's `fence` and `setIfFence`.

- 2173644: `cache.wrap` loads through a store outage: a store `get` that throws or rejects is a miss, so the loader answers, a failed `set` still returns the loaded value, and a `fence` that fails loads without caching. Failures go to the new `onStoreError(error, { op })`, which by default logs one line per operation per minute without the key. The explicit `get`, `set`, `delete`, `invalidateTag` and `clear` still reject. `revalidateEndpoint` takes `dataCaches`, caches such as a `@nifrajs/cache` holding loader data: a tag purge invalidates each of them before the page store and the CDN, and a failure answers `500` before the page store is touched. `createInvalidator` from `@nifrajs/web/cdn` takes the same `dataCaches`.

### Patch Changes

- 3d406b5: `MemoryCache` fences now compare only the changes that matter to a load: the key itself, its tags and `clear()`. The fence used to look back over the last 1024 changes of any kind, so under steady write traffic a slow load of a hot key was refused its write every time and the key never cached. Up to 65,536 distinct keys and tags are remembered; a fence older than a forgotten change is still refused.
- 602f55d: A `delete`, `invalidateTag`, `clear` or `set` now stops a `wrap` load or stale-while-revalidate refresh already running for that key or tag from storing its result. Before, a refresh that started before `invalidateTag` wrote the old value back for a new TTL. The next `wrap` after the invalidation runs its own load instead of joining the withdrawn one.

## 4.0.2

## 4.0.1

## 4.0.0

### Minor Changes

- ac703a1: `createCache({ observer })` reports every cache operation after it settles.

  - Each event carries `op` (`get`, `has`, `set`, `wrap`, `delete`, `invalidateTag`, `clear`, `revalidate`), `outcome` (`hit`, `stale`, `miss`, `ok`, `error`), `startedAt`, `durationMs`, `key`, `tag`, `tagCount` and the bound `context`.
  - `revalidate` is the background refresh a stale `wrap` starts, reported with the context whose read found the stale entry.
  - An observer that throws or rejects cannot change a result. Without an observer the cache reads no extra clock and allocates no event.
  - `cache.for(context)` works with an observer alone, so bound operations can be traced without a capability beacon. A beacon is still enforced whenever it is set.

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

### Patch Changes

- 7551709: Harden runtime boundaries and defaults: clean up subprocess abort listeners, support short Cloudflare
  KV sessions, bound and incrementally sweep the default memory cache, make image reads and cancellation
  safe, emit content-derived image validators, require trusted forwarded hosts, avoid caching dynamic SSR
  metadata, and reject invalid upload or image limits.

## 3.1.0

## 3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

### Patch Changes

- f7d68e8: Numeric limit options (body/payload byte caps, TTLs, cache sizes, concurrency, ISR revalidate windows) are now validated at construction and throw a `RangeError` on non-finite or out-of-range values instead of silently disabling the bound - a `NaN` cap previously made `size > max` comparisons fail open. JWT `requiredClaims` now checks own properties only, so inherited names like `toString` no longer satisfy a required claim. `@nifrajs/mcp-db` gates multi-statement input with a real tokenizer, bounds `run_query` materialization to `maxRows + 1` via a wrapping subquery, and skips SQLite planner pseudo-nodes when verifying the table allowlist. `nifra scaffold` refuses to write through symlinked route directories.

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

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

### Minor Changes

- 8b5f045: feat(cache): add `@nifrajs/cache` - typed KV cache

  TTL, stale-while-revalidate, tag invalidation, and single-flight stampede protection on a pluggable
  store (an in-memory default with lazy expiry + a tag index + an optional LRU cap; bring CF KV / Redis for
  a shared cache). `wrap(key, loader, { ttlMs, swrMs, tags })` is the cache-aside primitive for loaders:
  fresh hits skip the loader, stale-but-live values are served instantly while a background refresh runs,
  and concurrent misses share one load. Dependency-free; runs on Bun/Node/Deno/Workers.
