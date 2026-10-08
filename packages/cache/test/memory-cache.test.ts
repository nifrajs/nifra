import { describe, expect, test } from "bun:test"
import { MemoryCache } from "../src/index.ts"

const entry = (value: unknown, expiresAt: number, staleAt = expiresAt) => ({
  value,
  expiresAt,
  staleAt,
})

describe("MemoryCache", () => {
  test("setIfFence writes only when nothing a load must respect changed since the fence", () => {
    const changes: readonly [string, (store: MemoryCache) => void, boolean][] = [
      ["unrelated set", (store) => store.set("other", entry(1, 10), ["other"]), true],
      ["set of the key", (store) => store.set("k", entry("newer", 10), []), false],
      ["delete of the key", (store) => store.delete("k"), false],
      ["invalidateTag of its tag", (store) => store.invalidateTag("t"), false],
      ["clear", (store) => store.clear(), false],
    ]
    for (const [, change, writes] of changes) {
      const store = new MemoryCache({ now: () => 0 })
      const token = store.fence()
      change(store)
      expect(store.setIfFence("k", entry("loaded", 10), ["t"], token)).toBe(writes)
      expect(store.get("k")?.value === "loaded").toBe(writes)
    }
  })

  test("a fence older than the change log is refused, never trusted", () => {
    const store = new MemoryCache({ now: () => 0 })
    const token = store.fence()
    for (let i = 0; i <= 1024; i++) store.set(`other-${i}`, entry(i, 10), [])
    expect(store.setIfFence("k", entry("loaded", 10), [], token)).toBe(false)
    expect(store.setIfFence("k", entry("loaded", 10), [], "not-a-token")).toBe(false)
    expect(store.setIfFence("k", entry("loaded", 10), [], store.fence())).toBe(true)
  })

  test("rejects a non-finite entry cap", () => {
    expect(() => new MemoryCache({ maxEntries: Number.NaN })).toThrow(/maxEntries/)
  })

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

  test("the default cache is bounded; zero is the explicit unbounded opt-in", () => {
    const bounded = new MemoryCache()
    for (let i = 0; i < 10_001; i++) {
      bounded.set(String(i), entry(i, Number.MAX_SAFE_INTEGER), [])
    }
    expect(bounded.size()).toBe(10_000)
    expect(bounded.get("0")).toBeUndefined()

    const unbounded = new MemoryCache({ maxEntries: 0 })
    for (let i = 0; i < 10_001; i++) {
      unbounded.set(String(i), entry(i, Number.MAX_SAFE_INTEGER), [])
    }
    expect(unbounded.size()).toBe(10_001)
  })

  test("writes incrementally reclaim expired keys that are never read again", () => {
    const clock = { ms: 0 }
    const c = new MemoryCache({ now: () => clock.ms })
    for (let i = 0; i < 24; i++) c.set(`expired-${i}`, entry(i, 10), [])
    clock.ms = 10
    // Three fixed-size sweep batches are enough to visit all 24 cold rows.
    for (let i = 0; i < 4; i++) c.set(`live-${i}`, entry(i, 100), [])
    expect(c.size()).toBe(4)
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
