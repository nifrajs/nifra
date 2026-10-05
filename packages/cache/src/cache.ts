/**
 * The cache facade - typed get/set/wrap over a {@link CacheStore}, with TTL, stale-while-revalidate, and
 * single-flight stampede protection. Mirrors the other nifra primitives: a factory, an injectable clock,
 * and error isolation (a background revalidation that throws goes to `onError`, never rejects the caller).
 *
 *   import { createCache } from "@nifrajs/cache"
 *
 *   const cache = createCache({ defaultTtlMs: 30_000 })
 *   // Cache-aside in a loader - one DB hit per 30s per key, stampede-safe:
 *   const user = await cache.wrap(`user:${id}`, () => db.user(id), { ttlMs: 30_000, swrMs: 60_000, tags: [`user:${id}`] })
 *   await cache.invalidateTag(`user:${id}`) // on write
 */
import { MemoryCache } from "./memory-cache.ts"
import type {
  Cache,
  CacheEvent,
  CacheObserver,
  CacheOperation,
  CacheOptions,
  CacheOutcome,
  CacheStore,
  SetOptions,
  StoredEntry,
  WrapOptions,
} from "./types.ts"

function assertDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`[nifra/cache] ${name} must be a finite non-negative number`)
  }
}

function notify(observer: CacheObserver, event: CacheEvent): void {
  try {
    const result: unknown = observer(event)
    if (result instanceof Promise) result.catch(() => undefined)
  } catch {
    // An observer can never change a cache result.
  }
}

function report(
  observer: CacheObserver,
  op: CacheOperation,
  outcome: CacheOutcome,
  started: number,
  key: string | undefined,
  tag: string | undefined,
  tagCount: number,
  context: object | undefined,
): void {
  notify(observer, {
    op,
    outcome,
    startedAt: performance.timeOrigin + started,
    durationMs: performance.now() - started,
    key,
    tag,
    tagCount,
    context,
  })
}

/** Create a cache over the given (or a fresh in-memory) store. */
export function createCache(options: CacheOptions = {}): Cache {
  const defaultTtlMs = options.defaultTtlMs ?? 60_000
  assertDuration(defaultTtlMs, "defaultTtlMs")
  const now = options.now ?? (() => Date.now())
  // The default store must share the facade's clock, or test-injected timestamps look instantly expired.
  const store: CacheStore = options.store ?? new MemoryCache({ now })
  const onError =
    options.onError ??
    ((error, key) =>
      console.error(`[nifra/cache] revalidate ${JSON.stringify(key)} failed:`, error))

  const observer = options.observer
  // Single-flight: concurrent loads for the same key share one promise (miss stampede + SWR dedup).
  const inflight = new Map<string, Promise<unknown>>()

  async function get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = await store.get(key)
    return entry === undefined ? undefined : (entry.value as T)
  }

  async function has(key: string): Promise<boolean> {
    return (await store.get(key)) !== undefined
  }

  async function set<T>(key: string, value: T, opts: SetOptions = {}): Promise<void> {
    const ttlMs = opts.ttlMs ?? defaultTtlMs
    const swrMs = opts.swrMs ?? 0
    assertDuration(ttlMs, "ttlMs")
    assertDuration(swrMs, "swrMs")
    const t = now()
    await store.set(
      key,
      { value, staleAt: t + ttlMs, expiresAt: t + ttlMs + swrMs },
      opts.tags ?? [],
    )
  }

  function load(key: string, loader: () => unknown, opts: WrapOptions): Promise<unknown> {
    const existing = inflight.get(key)
    if (existing !== undefined) return existing
    const p = (async () => {
      const value = await loader()
      await set(key, value, opts)
      return value
    })().finally(() => {
      if (inflight.get(key) === p) inflight.delete(key)
    })
    inflight.set(key, p)
    return p
  }

  function revalidate(
    key: string,
    loader: () => unknown,
    opts: WrapOptions,
    context: object | undefined,
  ): void {
    if (inflight.has(key)) return // a refresh is already running
    const started = observer === undefined ? 0 : performance.now()
    const refresh = load(key, loader, opts)
    if (observer !== undefined) {
      const tagCount = opts.tags?.length ?? 0
      refresh.then(
        () => report(observer, "revalidate", "ok", started, key, undefined, tagCount, context),
        () => report(observer, "revalidate", "error", started, key, undefined, tagCount, context),
      )
    }
    void refresh.catch((error) => {
      try {
        onError(error, key)
      } catch {
        /* a throwing onError must not surface */
      }
    })
  }

  async function wrap<T>(
    key: string,
    loader: () => T,
    opts: WrapOptions = {},
  ): Promise<Awaited<T>> {
    const entry = await store.get(key)
    if (entry !== undefined) {
      if (now() < entry.staleAt) return entry.value as Awaited<T> // fresh hit
      revalidate(key, loader as () => unknown, opts, undefined) // stale-but-live → serve stale, refresh in background
      return entry.value as Awaited<T>
    }
    return (await load(key, loader as () => unknown, opts)) as Awaited<T> // miss → load (single-flight)
  }

  const readOutcome = (entry: StoredEntry | undefined): CacheOutcome =>
    entry === undefined ? "miss" : now() < entry.staleAt ? "hit" : "stale"

  // A separate surface rather than branches in the plain one, so a cache without an observer runs
  // exactly the code it ran before observers existed.
  function observed(observer: CacheObserver, context: object | undefined): Cache {
    const settle = async <T>(
      op: CacheOperation,
      key: string | undefined,
      tag: string | undefined,
      tagCount: number,
      run: () => Promise<T>,
      success: CacheOutcome,
    ): Promise<T> => {
      const started = performance.now()
      let outcome: CacheOutcome = "error"
      try {
        const value = await run()
        outcome = success
        return value
      } finally {
        report(observer, op, outcome, started, key, tag, tagCount, context)
      }
    }
    const read = async <T>(op: "get" | "has", key: string, pick: (e?: StoredEntry) => T) => {
      const started = performance.now()
      let outcome: CacheOutcome = "error"
      try {
        const entry = await store.get(key)
        outcome = readOutcome(entry)
        return pick(entry)
      } finally {
        report(observer, op, outcome, started, key, undefined, 0, context)
      }
    }
    return {
      get: <T = unknown>(key: string): Promise<T | undefined> =>
        read("get", key, (entry) =>
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the store keeps values untyped; T is the caller's claim for this key, exactly as in the plain get().
          entry === undefined ? undefined : (entry.value as T),
        ),
      has: (key) => read("has", key, (entry) => entry !== undefined),
      set: (key, value, opts) =>
        settle("set", key, undefined, opts?.tags?.length ?? 0, () => set(key, value, opts), "ok"),
      async wrap<T>(key: string, loader: () => T, opts: WrapOptions = {}): Promise<Awaited<T>> {
        const started = performance.now()
        let outcome: CacheOutcome = "error"
        try {
          const entry = await store.get(key)
          if (entry !== undefined) {
            outcome = readOutcome(entry)
            if (outcome === "stale") revalidate(key, loader, opts, context)
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the store keeps values untyped; a wrap of this key stored what a loader of the caller's T returned.
            return entry.value as Awaited<T>
          }
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: load() resolves to what this loader returned, or what a concurrent wrap of the same key loaded for the same T.
          const value = (await load(key, loader, opts)) as Awaited<T>
          outcome = "miss"
          return value
        } finally {
          report(
            observer,
            "wrap",
            outcome,
            started,
            key,
            undefined,
            opts.tags?.length ?? 0,
            context,
          )
        }
      },
      delete: (key) =>
        settle("delete", key, undefined, 0, () => Promise.resolve(store.delete(key)), "ok"),
      invalidateTag: (tag) =>
        settle(
          "invalidateTag",
          undefined,
          tag,
          1,
          () => Promise.resolve(store.invalidateTag(tag)),
          "ok",
        ),
      clear: () =>
        settle("clear", undefined, undefined, 0, () => Promise.resolve(store.clear()), "ok"),
      for: bind,
    }
  }

  const readToken = options.capabilities?.read ?? "cache.read"
  const writeToken = options.capabilities?.write ?? "cache.write"

  const plain: Cache =
    observer === undefined
      ? {
          get,
          has,
          set,
          wrap,
          delete: (key) => Promise.resolve(store.delete(key)),
          invalidateTag: (tag) => Promise.resolve(store.invalidateTag(tag)),
          clear: () => Promise.resolve(store.clear()),
          for: bind,
        }
      : observed(observer, undefined)

  // Built per call rather than cached per context: a cache keyed by context would hold every request's
  // context object for the process lifetime, which is a leak with a request body attached to it.
  function bind(context: object): Cache {
    const beacon = options.beacon
    if (beacon === undefined && observer === undefined) {
      throw new Error(
        "@nifrajs/cache: for(context) needs a beacon or an observer - pass `beacon: useCapability` (from @nifrajs/core/capabilities) or `observer` to createCache",
      )
    }
    const base = observer === undefined ? plain : observed(observer, context)
    if (beacon === undefined) return base
    // A refused capability has to surface as a REJECTION, not a synchronous throw: every method here
    // returns a promise, and a caller who writes `.catch(…)` instead of `try` would otherwise miss it
    // entirely - turning a fail-closed gate into an unhandled crash.
    const guard = <T>(capabilities: readonly string[], run: () => Promise<T>): Promise<T> => {
      try {
        for (const capability of capabilities) beacon(context, capability)
      } catch (error) {
        return Promise.reject(error)
      }
      return run()
    }
    const READ = [readToken]
    const WRITE = [writeToken]
    return {
      get: <T = unknown>(key: string): Promise<T | undefined> =>
        guard(READ, () => base.get<T>(key)),
      has: (key) => guard(READ, () => base.has(key)),
      set: <T>(key: string, value: T, opts?: SetOptions): Promise<void> =>
        guard(WRITE, () => base.set(key, value, opts)),
      // Both, because a miss writes and which one happens is not knowable before the call.
      wrap: <T>(key: string, loader: () => T, opts?: WrapOptions): Promise<Awaited<T>> =>
        guard([readToken, writeToken], () => base.wrap(key, loader, opts)),
      delete: (key) => guard(WRITE, () => base.delete(key)),
      invalidateTag: (tag) => guard(WRITE, () => base.invalidateTag(tag)),
      clear: () => guard(WRITE, () => base.clear()),
      for: bind,
    }
  }

  return plain
}
