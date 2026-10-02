import { describe, expect, spyOn, test } from "bun:test"
import { type CacheEvent, type CacheStore, createCache, MemoryCache } from "../src/index.ts"

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let ms = start
  return { now: () => ms, advance: (d) => (ms += d) }
}

const flush = (): Promise<void> => Bun.sleep(2)

function recorder(): { events: CacheEvent[]; observer: (event: CacheEvent) => void } {
  const events: CacheEvent[] = []
  return { events, observer: (event) => events.push(event) }
}

const summary = (events: readonly CacheEvent[]) => events.map((e) => `${e.op}:${e.outcome}`)

describe("cache observer", () => {
  test("reports one event per operation with its outcome, after it settles", async () => {
    const clock = makeClock()
    const { events, observer } = recorder()
    const cache = createCache({ now: clock.now, observer })

    expect(await cache.get("k")).toBeUndefined()
    expect(await cache.has("k")).toBe(false)
    await cache.set("k", "v", { ttlMs: 100, swrMs: 1000, tags: ["a", "b"] })
    expect(await cache.get<string>("k")).toBe("v")
    expect(await cache.has("k")).toBe(true)
    clock.advance(200)
    expect(await cache.get<string>("k")).toBe("v")
    await cache.delete("k")
    await cache.invalidateTag("a")
    await cache.clear()

    expect(summary(events)).toEqual([
      "get:miss",
      "has:miss",
      "set:ok",
      "get:hit",
      "has:hit",
      "get:stale",
      "delete:ok",
      "invalidateTag:ok",
      "clear:ok",
    ])
    expect(events[2]).toMatchObject({ key: "k", tag: undefined, tagCount: 2 })
    expect(events[7]).toMatchObject({ key: undefined, tag: "a", tagCount: 1 })
    expect(events[8]).toMatchObject({ key: undefined, tag: undefined, tagCount: 0 })
    for (const event of events) {
      expect(event.context).toBeUndefined()
      expect(event.durationMs).toBeGreaterThanOrEqual(0)
      expect(Math.abs(event.startedAt - Date.now())).toBeLessThan(60_000)
    }
  })

  test("wrap reports miss, hit and stale, and the stale read's background refresh as revalidate", async () => {
    const clock = makeClock()
    const { events, observer } = recorder()
    const cache = createCache({ now: clock.now, observer })
    let version = 0
    const load = () => `v${++version}`
    const opts = { ttlMs: 100, swrMs: 1000, tags: ["t"] }

    expect(await cache.wrap("k", load, opts)).toBe("v1")
    expect(await cache.wrap("k", load, opts)).toBe("v1")
    clock.advance(200)
    expect(await cache.wrap("k", load, opts)).toBe("v1")
    await flush()
    expect(await cache.wrap("k", load, opts)).toBe("v2")

    expect(summary(events)).toEqual([
      "wrap:miss",
      "wrap:hit",
      "wrap:stale",
      "revalidate:ok",
      "wrap:hit",
    ])
    expect(events[3]).toMatchObject({ key: "k", tagCount: 1 })
  })

  test("a throwing store, loader or background refresh reports error and still rejects as before", async () => {
    const clock = makeClock()
    const { events, observer } = recorder()
    const errors: unknown[] = []
    const cache = createCache({ now: clock.now, observer, onError: (error) => errors.push(error) })

    await expect(
      cache.wrap("boom", () => {
        throw new Error("loader failed")
      }),
    ).rejects.toThrow("loader failed")

    await cache.set("k", "v", { ttlMs: 10, swrMs: 1000 })
    clock.advance(20)
    expect(
      await cache.wrap("k", (): string => {
        throw new Error("refresh failed")
      }),
    ).toBe("v")
    await flush()
    expect(errors).toHaveLength(1)

    const failing: CacheStore = {
      get: () => {
        throw new Error("store down")
      },
      set: () => undefined,
      delete: () => {
        throw new Error("store down")
      },
      invalidateTag: () => undefined,
      clear: () => undefined,
    }
    const broken = createCache({ store: failing, observer })
    await expect(broken.get("x")).rejects.toThrow("store down")
    await expect(broken.delete("x")).rejects.toThrow("store down")

    expect(summary(events)).toEqual([
      "wrap:error",
      "set:ok",
      "wrap:stale",
      "revalidate:error",
      "get:error",
      "delete:error",
    ])
  })

  test("an observer that throws or rejects cannot change a result", async () => {
    let calls = 0
    const throwing = createCache({
      observer: () => {
        calls++
        throw new Error("observer bug")
      },
    })
    expect(await throwing.wrap("k", () => 1)).toBe(1)
    expect(await throwing.get<number>("k")).toBe(1)

    const rejecting = createCache({
      observer: async () => {
        calls++
        throw new Error("async observer bug")
      },
    })
    expect(await rejecting.wrap("k", () => 2)).toBe(2)
    await flush()
    expect(calls).toBe(3)
  })

  test("without an observer the cache reads no extra clock", async () => {
    const clock = makeClock()
    let reads = 0
    const now = () => {
      reads++
      return clock.now()
    }
    const monotonic = spyOn(performance, "now")
    try {
      const cache = createCache({ now, store: new MemoryCache({ now: clock.now }) })
      await cache.get("k")
      await cache.has("k")
      await cache.set("k", 1, { ttlMs: 10, swrMs: 100 })
      await cache.wrap("k", () => 2)
      clock.advance(20)
      await cache.wrap("k", () => 3)
      await flush()
      await cache.delete("k")
      await cache.invalidateTag("t")
      await cache.clear()
      expect(monotonic).not.toHaveBeenCalled()
      // set + wrap(hit) + wrap(stale) + the background refresh's set: the TTL clock only.
      expect(reads).toBe(4)
    } finally {
      monotonic.mockRestore()
    }
  })

  test("for(context) works with an observer alone and stamps the context on every event", async () => {
    const { events, observer } = recorder()
    const cache = createCache({ observer })
    const context = { request: 1 }
    const bound = cache.for(context)

    await bound.wrap("k", () => 1)
    await bound.get("k")
    await bound.for(context).delete("k")
    await cache.get("k")

    expect(events.map((e) => e.context)).toEqual([context, context, context, undefined])
  })

  test("a beacon is still enforced when an observer is also set", async () => {
    const { events, observer } = recorder()
    const seen: string[] = []
    const cache = createCache({
      observer,
      beacon: (_context, capability) => {
        seen.push(capability)
        if (capability === "cache.write") throw new Error("undeclared")
      },
    })
    const bound = cache.for({})
    expect(await bound.get("k")).toBeUndefined()
    await expect(bound.set("k", 1)).rejects.toThrow("undeclared")
    expect(seen).toEqual(["cache.read", "cache.write"])
    // The refused write never reached the store, so it reports nothing.
    expect(summary(events)).toEqual(["get:miss"])
  })

  test("a stale read on a bound view hands its context to the revalidate event", async () => {
    const clock = makeClock()
    const { events, observer } = recorder()
    const cache = createCache({ now: clock.now, observer })
    const context = { request: "r1" }
    await cache.set("k", "v", { ttlMs: 1, swrMs: 100 })
    clock.advance(5)
    await cache.for(context).wrap("k", () => "v2")
    await flush()
    const revalidate = events.find((e) => e.op === "revalidate")
    expect(revalidate?.context).toBe(context)
  })
})
