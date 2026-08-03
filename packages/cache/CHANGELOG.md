# @nifrajs/cache

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
