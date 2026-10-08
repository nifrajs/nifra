import { describe, expect, spyOn, test } from "bun:test"
import { type CacheEvent, type CacheStore, createCache, MemoryCache } from "../src/index.ts"

// A cache-aside read degrades to its loader when the store fails: the loader is the source of truth,
// so an outage costs latency, not an error. Explicit operations still surface the failure.

type Op = "get" | "set" | "delete" | "invalidateTag" | "clear"

function storeFailing(ops: readonly Op[], how: "reject" | "throw" = "reject"): CacheStore {
  const inner = new MemoryCache()
  const fail = (op: Op, key: string) => {
    const error = new Error(`store ${op} down for ${key}`)
    if (how === "throw") throw error
    return Promise.reject(error)
  }
  return {
    get: (key) => (ops.includes("get") ? fail("get", key) : inner.get(key)),
    set: (key, entry, tags) =>
      ops.includes("set") ? fail("set", key) : inner.set(key, entry, tags),
    delete: (key) => (ops.includes("delete") ? fail("delete", key) : inner.delete(key)),
    invalidateTag: (tag) =>
      ops.includes("invalidateTag") ? fail("invalidateTag", tag) : inner.invalidateTag(tag),
    clear: () => (ops.includes("clear") ? fail("clear", "") : inner.clear()),
  }
}

describe("wrap over a failing store", () => {
  test("a get that rejects or throws is a miss: the loader answers", async () => {
    for (const how of ["reject", "throw"] as const) {
      const reports: string[] = []
      const cache = createCache({
        store: storeFailing(["get"], how),
        onStoreError: (_error, info) => reports.push(info.op),
      })
      let calls = 0
      const value = await cache.wrap("user:1", () => {
        calls++
        return { id: 1 }
      })
      expect(value).toEqual({ id: 1 })
      expect(calls).toBe(1)
      expect(reports).toEqual(["get"])
    }
  })

  test("a set that fails still returns the loaded value", async () => {
    const reports: string[] = []
    const cache = createCache({
      store: storeFailing(["set"]),
      onStoreError: (_error, info) => reports.push(info.op),
    })
    expect(await cache.wrap("k", () => "loaded")).toBe("loaded")
    expect(reports).toEqual(["set"])
  })

  test("concurrent wraps for one key share one load while the store is down", async () => {
    const cache = createCache({ store: storeFailing(["get", "set"]), onStoreError: () => {} })
    let calls = 0
    const loader = async () => {
      calls++
      await Promise.resolve()
      return "v"
    }
    expect(await Promise.all([1, 2, 3].map(() => cache.wrap("k", loader)))).toEqual(["v", "v", "v"])
    expect(calls).toBe(1)
  })

  test("a loader that throws still rejects", async () => {
    const cache = createCache({ store: storeFailing(["get"]), onStoreError: () => {} })
    await expect(
      cache.wrap("k", () => {
        throw new Error("source down")
      }),
    ).rejects.toThrow("source down")
  })

  test("by default one line per operation per minute is logged, without the key", async () => {
    let at = 1_000_000
    const cache = createCache({ store: storeFailing(["get"]), now: () => at })
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      await cache.wrap("user:secret-id", () => 1)
      await cache.wrap("user:secret-id", () => 1)
      expect(error).toHaveBeenCalledTimes(1)
      const line = String(error.mock.calls[0]?.[0])
      expect(line).toContain("store get failed")
      expect(line).not.toContain("secret-id")
      at += 60_000
      await cache.wrap("user:secret-id", () => 1)
      expect(error).toHaveBeenCalledTimes(2)
    } finally {
      error.mockRestore()
    }
  })

  test("a fence that fails loads uncached, and a fenced write that fails is a failed set", async () => {
    for (const how of ["reject", "throw"] as const) {
      const inner = new MemoryCache()
      const reports: string[] = []
      const cache = createCache({
        store: {
          get: (key) => inner.get(key),
          set: (key, entry, tags) => inner.set(key, entry, tags),
          delete: (key) => inner.delete(key),
          invalidateTag: (tag) => inner.invalidateTag(tag),
          clear: () => inner.clear(),
          fence: () => {
            const error = new Error("store fence down")
            if (how === "throw") throw error
            return Promise.reject(error)
          },
          setIfFence: (key, entry, tags, token) => inner.setIfFence(key, entry, tags, token),
        },
        onStoreError: (_error, info) => reports.push(info.op),
      })
      expect(await cache.wrap("k", () => "loaded")).toBe("loaded")
      expect(inner.size()).toBe(0)
      expect(reports).toEqual(["fence"])
    }
    const inner = new MemoryCache()
    const reports: string[] = []
    const cache = createCache({
      store: {
        get: (key) => inner.get(key),
        set: (key, entry, tags) => inner.set(key, entry, tags),
        delete: (key) => inner.delete(key),
        invalidateTag: (tag) => inner.invalidateTag(tag),
        clear: () => inner.clear(),
        fence: () => inner.fence(),
        setIfFence: () => Promise.reject(new Error("store set down")),
      },
      onStoreError: (_error, info) => reports.push(info.op),
    })
    expect(await cache.wrap("k", () => "loaded")).toBe("loaded")
    expect(reports).toEqual(["set"])
  })

  test("an observed wrap reports the miss it served", async () => {
    const events: CacheEvent[] = []
    const cache = createCache({
      store: storeFailing(["get"]),
      onStoreError: () => {},
      observer: (event) => events.push(event),
    })
    expect(await cache.wrap("k", () => "v")).toBe("v")
    expect(events.map((event) => `${event.op} ${event.outcome}`)).toEqual(["wrap miss"])
  })
})

test("explicit operations still reject, so a failed invalidation is never silent", async () => {
  const cache = createCache({
    store: storeFailing(["get", "set", "invalidateTag"]),
    onStoreError: () => {},
  })
  await expect(cache.get("k")).rejects.toThrow("store get down")
  await expect(cache.set("k", 1)).rejects.toThrow("store set down")
  await expect(cache.invalidateTag("t")).rejects.toThrow("store invalidateTag down")
})
