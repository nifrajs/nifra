# @nifrajs/cache

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

- 8b5f045: feat(cache): add `@nifrajs/cache` — typed KV cache

  TTL, stale-while-revalidate, tag invalidation, and single-flight stampede protection on a pluggable
  store (an in-memory default with lazy expiry + a tag index + an optional LRU cap; bring CF KV / Redis for
  a shared cache). `wrap(key, loader, { ttlMs, swrMs, tags })` is the cache-aside primitive for loaders:
  fresh hits skip the loader, stale-but-live values are served instantly while a background refresh runs,
  and concurrent misses share one load. Dependency-free; runs on Bun/Node/Deno/Workers.
