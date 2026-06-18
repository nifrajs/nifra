import { describe, expect, test } from "bun:test"
import { createQueryClient, hashQueryKey } from "../src/index.ts"

describe("hashQueryKey", () => {
  test("is stable + order-independent for objects, ordered for arrays, nested", () => {
    expect(hashQueryKey({ a: 1, b: 2 })).toBe(hashQueryKey({ b: 2, a: 1 }))
    expect(hashQueryKey(["todo", 1])).toBe('["todo",1]')
    expect(hashQueryKey({ x: { b: 1, a: 2 } })).toBe(hashQueryKey({ x: { a: 2, b: 1 } }))
    expect(hashQueryKey("k")).toBe('"k"')
  })
  test("throws on a non-serializable key (function/symbol)", () => {
    expect(() => hashQueryKey(["k", () => 1])).toThrow(/serializable/)
    expect(() => hashQueryKey({ s: Symbol("x") })).toThrow(/serializable/)
  })
})

// A controllable async fn: each call returns a promise resolved/rejected via the returned controls.
function gated() {
  let calls = 0
  const resolvers: Array<(v: unknown) => void> = []
  const rejecters: Array<(e: unknown) => void> = []
  const fn = () =>
    new Promise<unknown>((resolve, reject) => {
      calls++
      resolvers.push(resolve)
      rejecters.push(reject)
    })
  return {
    fn,
    calls: () => calls,
    resolve: (i: number, v: unknown) => resolvers[i]?.(v),
    reject: (i: number, e: unknown) => rejecters[i]?.(e),
  }
}

describe("createQueryClient", () => {
  test("query() returns a stable handle per key and re-binds the latest fn", () => {
    const c = createQueryClient({ now: () => 0 })
    const fn1 = async () => 1
    const h = c.query(["k"], fn1)
    expect(c.query(["k"], async () => 2)).toBe(h) // same key → same handle
    expect(c.query(["other"], fn1)).not.toBe(h)
  })

  test("fetch(): pending → fetching → success, with data + updatedAt", async () => {
    let t = 0
    const g = gated()
    const c = createQueryClient({ now: () => t })
    const h = c.query(["k"], g.fn)
    expect(h.snapshot().status).toBe("pending")
    const p = h.fetch()
    expect(h.snapshot().isFetching).toBe(true) // fetch started
    expect(g.calls()).toBe(1)
    t = 42
    g.resolve(0, "DATA")
    expect(await p).toBe("DATA")
    expect(h.snapshot()).toMatchObject({
      status: "success",
      data: "DATA",
      isFetching: false,
      updatedAt: 42,
    })
  })

  test("fetch() is a fresh cache hit within staleTime (no fn call); refetches once stale", async () => {
    let t = 0
    const g = gated()
    const c = createQueryClient({ now: () => t, staleTime: 1000 })
    const h = c.query(["k"], g.fn)
    const p = h.fetch()
    g.resolve(0, "v1")
    await p
    expect(g.calls()).toBe(1)
    t = 500 // < staleTime
    expect(await h.fetch()).toBe("v1") // fresh hit
    expect(g.calls()).toBe(1) // no new fetch
    t = 1500 // >= staleTime → stale
    const p2 = h.fetch()
    expect(g.calls()).toBe(2) // refetched
    g.resolve(1, "v2")
    expect(await p2).toBe("v2")
  })

  test("concurrent fetch() calls dedup into one in-flight fetch", async () => {
    const g = gated()
    const c = createQueryClient({ now: () => 0 })
    const h = c.query(["k"], g.fn)
    const p1 = h.fetch()
    const p2 = h.fetch()
    expect(p1).toBe(p2) // same promise
    expect(g.calls()).toBe(1) // one fn call
    g.resolve(0, "X")
    expect(await Promise.all([p1, p2])).toEqual(["X", "X"])
  })

  test("a failed fetch sets the error state and rejects", async () => {
    const g = gated()
    const c = createQueryClient({ now: () => 0 })
    const h = c.query(["k"], g.fn)
    const p = h.fetch()
    g.reject(0, new Error("boom"))
    await expect(p).rejects.toThrow("boom")
    expect(h.snapshot()).toMatchObject({ status: "error", isFetching: false })
    expect((h.snapshot().error as Error).message).toBe("boom")
  })

  test("refetch() forces a fetch even when fresh", async () => {
    let t = 0
    const g = gated()
    const c = createQueryClient({ now: () => t, staleTime: 1000 })
    const h = c.query(["k"], g.fn)
    const p0 = h.fetch() // fetch first (registers the resolver), then resolve it
    g.resolve(0, "a")
    await p0
    expect(g.calls()).toBe(1)
    t = 10 // still fresh
    const p = h.refetch() // force despite freshness
    expect(g.calls()).toBe(2)
    g.resolve(1, "b")
    expect(await p).toBe("b")
  })

  test("invalidateQueries(key) marks an exact-match query stale → next fetch refetches", async () => {
    const g = gated()
    const c = createQueryClient({ now: () => 0, staleTime: 1_000_000 }) // effectively never stale by time
    const h = c.query(["k"], g.fn)
    const p0 = h.fetch()
    g.resolve(0, "a")
    await p0
    expect(await h.fetch()).toBe("a") // fresh (calls=1)
    expect(g.calls()).toBe(1)
    c.invalidateQueries(["k"]) // no subscribers → just marked stale
    const p = h.fetch()
    expect(g.calls()).toBe(2) // invalidation forced a refetch despite freshness
    g.resolve(1, "b")
    expect(await p).toBe("b")
  })

  test("invalidateQueries matches a non-array (exact) key, and skips a different one", async () => {
    const g = gated()
    const c = createQueryClient({ now: () => 0, staleTime: 1_000_000 })
    const h = c.query("settings", g.fn) // string (non-array) key
    const p0 = h.fetch()
    g.resolve(0, "s1")
    await p0
    expect(await h.fetch()).toBe("s1") // fresh
    c.invalidateQueries("settings") // non-array prefix → exact hash match
    const p = h.fetch()
    expect(g.calls()).toBe(2) // refetched
    g.resolve(1, "s2")
    expect(await p).toBe("s2")
    const g2 = gated()
    const h2 = c.query("other", g2.fn)
    const p2 = h2.fetch()
    g2.resolve(0, "o")
    await p2
    c.invalidateQueries("settings") // does NOT match "other"
    expect(await h2.fetch()).toBe("o") // still fresh
    expect(g2.calls()).toBe(1)
  })

  test("invalidateQueries(prefix) prefix-matches array keys and refetches mounted entries", async () => {
    const g1 = gated()
    const g2 = gated()
    const gOther = gated()
    const c = createQueryClient({ now: () => 0, staleTime: 1_000_000 })
    const h1 = c.query(["todo", "1"], g1.fn)
    const h2 = c.query(["todo", "2"], g2.fn)
    const hOther = c.query(["user", "1"], gOther.fn)
    const fetches = [h1.fetch(), h2.fetch(), hOther.fetch()] // fetch first (register resolvers)...
    g1.resolve(0, "t1")
    g2.resolve(0, "t2")
    gOther.resolve(0, "u1") // ...then resolve
    await Promise.all(fetches)
    h1.subscribe(() => {}) // mounted → invalidate should refetch it immediately
    c.invalidateQueries(["todo"]) // prefix → h1 + h2 (not hOther)
    expect(g1.calls()).toBe(2) // mounted ["todo","1"] refetched now
    expect(gOther.calls()).toBe(1) // ["user","1"] untouched (prefix didn't match)
    // h2 was marked stale (not mounted) → refetches on next access
    void h2.fetch()
    expect(g2.calls()).toBe(2)
  })

  test("invalidateQueries swallows a mounted refetch failure (best-effort)", async () => {
    const g = gated()
    const c = createQueryClient({ now: () => 0, staleTime: 1_000_000 })
    const h = c.query(["x"], g.fn)
    const p0 = h.fetch()
    g.resolve(0, "ok")
    await p0
    h.subscribe(() => {}) // mounted
    c.invalidateQueries(["x"]) // → fire-and-forget refetch (calls=2)
    expect(g.calls()).toBe(2)
    g.reject(1, new Error("refetch-fail")) // the refetch rejects → the best-effort .catch swallows it
    await Promise.resolve()
    await Promise.resolve()
    expect(h.snapshot().status).toBe("error") // state reflects it; no unhandled rejection
  })

  test("snapshot is a stable reference between transitions, fresh on each change", async () => {
    const g = gated()
    const c = createQueryClient({ now: () => 0 })
    const h = c.query(["k"], g.fn)
    const s0 = h.snapshot()
    expect(h.snapshot()).toBe(s0) // no change → same ref
    const p = h.fetch()
    expect(h.snapshot()).not.toBe(s0) // isFetching change → new ref
    g.resolve(0, "v")
    await p
    expect(h.snapshot().data).toBe("v")
  })

  test("subscribe notifies on transitions; unsubscribe stops it", async () => {
    const g = gated()
    const c = createQueryClient({ now: () => 0 })
    const h = c.query(["k"], g.fn)
    let fires = 0
    const off = h.subscribe(() => fires++)
    const p = h.fetch() // fetching emit
    g.resolve(0, "v")
    await p // success emit
    expect(fires).toBeGreaterThanOrEqual(2)
    const settled = fires
    off()
    void h.refetch()
    expect(fires).toBe(settled) // unsubscribed → no more notifications
  })

  test("GC: an unsubscribed entry is evicted after gcTime; a subscribed one is kept", async () => {
    let t = 0
    const g = gated()
    const c = createQueryClient({ now: () => t, gcTime: 200 })
    const kept = c.query(["kept"], g.fn)
    kept.subscribe(() => {}) // stays subscribed → never GC'd
    const off = c.query(["gone"], g.fn).subscribe(() => {})
    off() // subscribers → 0; gcAt = now()+200 = 200
    t = 100
    c.query(["touch"], g.fn) // triggers a sweep — 100 < 200, "gone" survives
    expect(c.query(["gone"], g.fn)).toBe(c.query(["gone"], g.fn)) // still the same cached entry
    const goneHandle = c.query(["gone"], g.fn)
    t = 300
    c.query(["touch2"], g.fn) // sweep — 300 >= 200 → "gone" evicted
    expect(c.query(["gone"], g.fn)).not.toBe(goneHandle) // re-created (was evicted)
    expect(c.query(["kept"], g.fn)).toBe(kept) // subscribed entry survived
  })

  test("the cache is bounded — past `max`, the oldest unsubscribed entries are evicted", () => {
    const g = gated()
    const c = createQueryClient({ now: () => 0, max: 3 })
    const first = c.query(["q", 0], g.fn) // oldest, unsubscribed
    for (let i = 1; i < 5; i++) c.query(["q", i], g.fn) // exceed max=3 → oldest unsubscribed evicted
    expect(c.query(["q", 0], g.fn)).not.toBe(first) // ["q",0] was evicted (re-created)
    expect(c.query(["q", 4], g.fn)).toBe(c.query(["q", 4], g.fn)) // recent entry retained
  })
})

describe("invalidation epoch (M3) + emit (Perf-6)", () => {
  // The core M3 bug: a fetch in flight when a mutation invalidates the query must NOT satisfy the
  // post-mutation refetch (its data is pre-mutation). Old behavior: refetch JOINED the in-flight
  // fetch, published its stale data as fresh, and cleared `invalidated` — the refetch never happened.
  test("invalidateQueries during an in-flight fetch supersedes it; stale result isn't published [AUDIT M3]", async () => {
    const g = gated()
    const c = createQueryClient({ now: () => 0, staleTime: 1_000_000 })
    const h = c.query(["k"], g.fn)
    h.subscribe(() => {}) // mounted → invalidate kicks an immediate refetch
    const p0 = h.fetch() // fetch #0 in flight (pre-mutation)
    expect(g.calls()).toBe(1)
    c.invalidateQueries(["k"]) // mutation: supersede #0 and kick a fresh fetch #1
    expect(g.calls()).toBe(2) // a NEW fetch was started, NOT joined to the in-flight one (the bug)
    g.resolve(0, "STALE") // the superseded pre-mutation fetch resolves
    await p0 // resolves to its raw value, but must not publish to state
    await Promise.resolve()
    expect(h.snapshot().data).not.toBe("STALE") // stale data was discarded, not published as fresh
    g.resolve(1, "FRESH") // the post-mutation fetch resolves
    await Promise.resolve()
    await Promise.resolve()
    expect(h.snapshot()).toMatchObject({ status: "success", data: "FRESH" })
  })

  test("no-subscriber invalidate: a late in-flight result doesn't clear the invalidation [AUDIT M3]", async () => {
    const g = gated()
    const c = createQueryClient({ now: () => 0, staleTime: 1_000_000 })
    const h = c.query(["k"], g.fn) // NOT subscribed → invalidate marks stale but kicks no refetch
    const p0 = h.fetch() // #0 in flight
    c.invalidateQueries(["k"])
    expect(g.calls()).toBe(1) // no refetch kicked (no subscribers)
    g.resolve(0, "STALE") // the pre-invalidation fetch resolves
    await p0
    await Promise.resolve()
    const p1 = h.fetch() // next access must refetch (invalidation survived), not serve STALE as fresh
    expect(g.calls()).toBe(2)
    g.resolve(1, "FRESH")
    expect(await p1).toBe("FRESH")
  })

  test("a superseded in-flight fetch that REJECTS doesn't publish an error [AUDIT M3]", async () => {
    const g = gated()
    const c = createQueryClient({ now: () => 0, staleTime: 1_000_000 })
    const h = c.query(["k"], g.fn)
    h.subscribe(() => {})
    const p0 = h.fetch() // #0
    c.invalidateQueries(["k"]) // supersede #0, kick #1
    g.reject(0, new Error("stale-boom")) // the superseded fetch fails
    await p0.catch(() => {})
    await Promise.resolve()
    expect(h.snapshot().status).not.toBe("error") // a superseded rejection must not set error state
    g.resolve(1, "FRESH")
    await Promise.resolve()
    await Promise.resolve()
    expect(h.snapshot()).toMatchObject({ status: "success", data: "FRESH" })
  })

  test("a listener unsubscribing during notification doesn't break the emit [AUDIT Perf-6]", async () => {
    const g = gated()
    const c = createQueryClient({ now: () => 0 })
    const h = c.query(["k"], g.fn)
    const seen: string[] = []
    let unsubTwo = (): void => {}
    h.subscribe(() => {
      seen.push("one")
      unsubTwo() // remove the other subscriber mid-emit — must not throw (live-set iteration)
    })
    unsubTwo = h.subscribe(() => seen.push("two"))
    const p = h.fetch() // setState(isFetching) → emit over the live listener set
    g.resolve(0, "v")
    await p
    expect(seen).toContain("one") // notified without throwing despite the mid-emit unsubscribe
  })
})
