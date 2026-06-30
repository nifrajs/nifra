import { describe, expect, test } from "bun:test"
import { MemoryCache } from "../src/index.ts"

const entry = (value: unknown, expiresAt: number, staleAt = expiresAt) => ({
  value,
  expiresAt,
  staleAt,
})

describe("MemoryCache", () => {
  test("set → get returns the live entry; expired → undefined + evicted", () => {
    const clock = { ms: 0 }
    const c = new MemoryCache({ now: () => clock.ms })
    c.set("k", entry("v", 100), [])
    expect(c.get("k")?.value).toBe("v")
    clock.ms = 100
    expect(c.get("k")).toBeUndefined()
    expect(c.size()).toBe(0) // lazily evicted on the expired read
  })

  test("LRU cap evicts the least-recently-used; get touches recency", () => {
    const c = new MemoryCache({ maxEntries: 2 })
    c.set("a", entry(1, Number.MAX_SAFE_INTEGER), [])
    c.set("b", entry(2, Number.MAX_SAFE_INTEGER), [])
    c.get("a") // touch a → b is now LRU
    c.set("c", entry(3, Number.MAX_SAFE_INTEGER), []) // overflow → evict b
    expect(c.get("a")?.value).toBe(1)
    expect(c.get("b")).toBeUndefined()
    expect(c.get("c")?.value).toBe(3)
  })

  test("invalidateTag removes tagged keys and cleans the tag index", () => {
    const c = new MemoryCache()
    c.set("a", entry(1, Number.MAX_SAFE_INTEGER), ["t1"])
    c.set("b", entry(2, Number.MAX_SAFE_INTEGER), ["t1", "t2"])
    c.invalidateTag("t1")
    expect(c.get("a")).toBeUndefined()
    expect(c.get("b")).toBeUndefined()
    expect(c.size()).toBe(0)
    // Re-using t1 after its set emptied must not throw / leak.
    c.set("d", entry(4, Number.MAX_SAFE_INTEGER), ["t1"])
    expect(c.get("d")?.value).toBe(4)
  })

  test("overwriting a key re-links its tags (no stale tag references)", () => {
    const c = new MemoryCache()
    c.set("k", entry(1, Number.MAX_SAFE_INTEGER), ["old"])
    c.set("k", entry(2, Number.MAX_SAFE_INTEGER), ["new"])
    c.invalidateTag("old") // should NOT drop k (re-tagged to "new")
    expect(c.get("k")?.value).toBe(2)
    c.invalidateTag("new")
    expect(c.get("k")).toBeUndefined()
  })

  test("clear empties values + tags", () => {
    const c = new MemoryCache()
    c.set("a", entry(1, Number.MAX_SAFE_INTEGER), ["t"])
    c.clear()
    expect(c.size()).toBe(0)
    expect(c.get("a")).toBeUndefined()
  })
})
