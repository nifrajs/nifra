import { describe, expect, test } from "bun:test"
import { createCache } from "../src/index.ts"

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let ms = start
  return { now: () => ms, advance: (d) => (ms += d) }
}

/** Let any fire-and-forget background revalidation settle. */
const flush = (): Promise<void> => Bun.sleep(2)

describe("createCache — wrap (cache-aside)", () => {
  test("a miss loads + caches; a fresh hit does not call the loader", async () => {
    const clock = makeClock()
    const cache = createCache({ now: clock.now, defaultTtlMs: 1000 })
    let calls = 0
    const load = () => {
      calls += 1
      return "v"
    }
    expect(await cache.wrap("k", load)).toBe("v")
    clock.advance(500) // still fresh
    expect(await cache.wrap("k", load)).toBe("v")
    expect(calls).toBe(1)
  })

  test("hard expiry: get returns undefined past ttl+swr", async () => {
    const clock = makeClock()
    const cache = createCache({ now: clock.now })
    await cache.set("k", "v", { ttlMs: 1000 })
    clock.advance(999)
    expect(await cache.get<string>("k")).toBe("v")
    clock.advance(2)
    expect(await cache.get("k")).toBeUndefined()
  })

  test("SWR: a stale-but-live value is returned immediately, then refreshed in the background", async () => {
    const clock = makeClock()
    const cache = createCache({ now: clock.now })
    let n = 0
    const load = () => `v${++n}`
    expect(await cache.wrap("k", load, { ttlMs: 1000, swrMs: 5000 })).toBe("v1")

    clock.advance(1500) // past staleAt (1000), before expiresAt (6000) → stale window
    expect(await cache.wrap("k", load, { ttlMs: 1000, swrMs: 5000 })).toBe("v1") // stale served instantly
    await flush() // background revalidation runs
    expect(n).toBe(2)
    expect(await cache.get<string>("k")).toBe("v2") // self-healed
  })

  test("stampede: concurrent misses for one key share a single loader call", async () => {
    const cache = createCache()
    let calls = 0
    const load = async () => {
      calls += 1
      await Bun.sleep(5)
      return "v"
    }
    const results = await Promise.all([
      cache.wrap("k", load),
      cache.wrap("k", load),
      cache.wrap("k", load),
    ])
    expect(results).toEqual(["v", "v", "v"])
    expect(calls).toBe(1)
  })

  test("a throwing loader is not cached", async () => {
    const cache = createCache()
    await expect(
      cache.wrap("k", () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(await cache.get("k")).toBeUndefined()
    expect(await cache.wrap("k", () => "ok")).toBe("ok") // recovers
  })
})

describe("createCache — invalidation", () => {
  test("invalidateTag drops every entry carrying the tag", async () => {
    const cache = createCache()
    await cache.set("a", 1, { tags: ["user:1"] })
    await cache.set("b", 2, { tags: ["user:1"] })
    await cache.set("c", 3, { tags: ["user:2"] })
    await cache.invalidateTag("user:1")
    expect(await cache.get("a")).toBeUndefined()
    expect(await cache.get("b")).toBeUndefined()
    expect(await cache.get<number>("c")).toBe(3)
  })

  test("delete + has + clear", async () => {
    const cache = createCache()
    await cache.set("k", "v")
    expect(await cache.has("k")).toBe(true)
    await cache.delete("k")
    expect(await cache.has("k")).toBe(false)
    await cache.set("x", 1)
    await cache.clear()
    expect(await cache.get("x")).toBeUndefined()
  })
})
