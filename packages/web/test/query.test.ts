import { describe, expect, test } from "bun:test"
import { createMutation, createQueryClient, hashQueryKey } from "../src/index.ts"

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

describe("imperative cache: getQueryData / setQueryData / prefetchQuery", () => {
  test("getQueryData is undefined until success, then returns the data", async () => {
    const c = createQueryClient({ now: () => 0 })
    expect(c.getQueryData(["k"])).toBeUndefined() // no entry
    c.query(["k"], async () => "v")
    expect(c.getQueryData(["k"])).toBeUndefined() // entry exists but pending
    await c.query(["k"], async () => "v").fetch()
    expect(c.getQueryData<string>(["k"])).toBe("v")
  })

  test("setQueryData writes a value (and via an updater) without a fetch", () => {
    const c = createQueryClient({ now: () => 5 })
    c.setQueryData(["count"], 1)
    expect(c.getQueryData<number>(["count"])).toBe(1)
    expect(c.query(["count"], async () => 99).snapshot()).toMatchObject({
      status: "success",
      data: 1,
      updatedAt: 5,
    })
    c.setQueryData<number>(["count"], (prev) => (prev ?? 0) + 10)
    expect(c.getQueryData<number>(["count"])).toBe(11)
  })

  test("a setQueryData-only key never fetches on its own", async () => {
    const c = createQueryClient({ now: () => 0 })
    c.setQueryData(["seeded"], "S")
    // No fetcher was ever bound; reading the (fresh, staleTime 0 but success) entry via a handle with a
    // real fn now would fetch — but simply reading data must not. The seeded value stands.
    expect(c.getQueryData<string>(["seeded"])).toBe("S")
  })

  test("prefetchQuery caches so a later fetch() is a fresh hit (no second fn call)", async () => {
    let t = 0
    const c = createQueryClient({ now: () => t, staleTime: 1000 })
    let calls = 0
    const fn = async () => {
      calls++
      return "P"
    }
    await c.prefetchQuery(["k"], fn)
    expect(calls).toBe(1)
    expect(c.getQueryData<string>(["k"])).toBe("P")
    t = 500 // still within staleTime
    await c.query(["k"], fn).fetch()
    expect(calls).toBe(1) // fresh cache hit — no refetch
  })

  test("setQueryData supersedes an in-flight fetch (optimistic write wins)", async () => {
    let t = 0
    const g = gated()
    const c = createQueryClient({ now: () => t })
    const h = c.query(["k"], g.fn)
    const p = h.fetch()
    c.setQueryData(["k"], "OPTIMISTIC") // write while the fetch is in flight
    t = 10
    g.resolve(0, "STALE") // the fetch resolves late — must NOT overwrite the optimistic value
    await p
    expect(c.getQueryData<string>(["k"])).toBe("OPTIMISTIC")
  })
})

describe("SSR bridge: dehydrate / hydrate", () => {
  test("dehydrate captures successful queries; hydrate seeds a fresh client", async () => {
    const server = createQueryClient({ now: () => 100 })
    await server.prefetchQuery(["user", 1], async () => ({ name: "Ada" }))
    server.query(["pending"], async () => "never fetched") // pending → not dehydrated
    const state = server.dehydrate()
    expect(state.queries).toEqual([{ key: ["user", 1], data: { name: "Ada" }, updatedAt: 100 }])

    const client = createQueryClient({ now: () => 200 })
    client.hydrate(state)
    expect(client.getQueryData<{ name: string }>(["user", 1])).toEqual({ name: "Ada" })
  })

  test("hydrate does not clobber a client entry that is already fresher", () => {
    const client = createQueryClient({ now: () => 0 })
    client.setQueryData(["k"], "CLIENT") // updatedAt 0
    client.hydrate({ queries: [{ key: ["k"], data: "SERVER", updatedAt: -50 }] }) // older snapshot
    expect(client.getQueryData<string>(["k"])).toBe("CLIENT")
    client.hydrate({ queries: [{ key: ["k"], data: "NEWER", updatedAt: 50 }] }) // newer snapshot wins
    expect(client.getQueryData<string>(["k"])).toBe("NEWER")
  })
})

describe("infiniteQuery", () => {
  const opts = {
    initialPageParam: 0,
    getNextPageParam: (last: string[], _all: readonly string[][], lastParam: number) =>
      last.length === 0 ? undefined : lastParam + 1,
  }
  // A pager: page N is [`a{N}`, `b{N}`], and page 2 is empty (end of list).
  const pager = (n: number): Promise<string[]> => Promise.resolve(n >= 2 ? [] : [`a${n}`, `b${n}`])

  test("fetch loads the first page; fetchNextPage appends", async () => {
    const c = createQueryClient({ now: () => 0 })
    const h = c.infiniteQuery(["feed"], pager, opts)
    await h.fetch()
    expect(h.snapshot().data).toEqual({ pages: [["a0", "b0"]], pageParams: [0] })
    expect(h.hasNextPage()).toBe(true)
    await h.fetchNextPage()
    expect(h.snapshot().data).toEqual({
      pages: [
        ["a0", "b0"],
        ["a1", "b1"],
      ],
      pageParams: [0, 1],
    })
  })

  test("hasNextPage is false once getNextPageParam returns undefined", async () => {
    const c = createQueryClient({ now: () => 0 })
    const h = c.infiniteQuery(["feed"], pager, opts)
    await h.fetch()
    await h.fetchNextPage() // page 1
    await h.fetchNextPage() // page 2 is empty → end
    expect(h.snapshot().data?.pages.length).toBe(3)
    expect(h.hasNextPage()).toBe(false)
    const before = h.snapshot().data
    expect(await h.fetchNextPage()).toBe(before as never) // no-op once exhausted
  })

  test("refetch re-runs every loaded page in order", async () => {
    let gen = "v1"
    const c = createQueryClient({ now: () => 0 })
    const h = c.infiniteQuery(["feed"], (n: number) => Promise.resolve([`${gen}-${n}`]), {
      initialPageParam: 0,
      getNextPageParam: (_l: string[], _a: readonly string[][], p: number) => p + 1,
    })
    await h.fetch()
    await h.fetchNextPage()
    expect(h.snapshot().data?.pages).toEqual([["v1-0"], ["v1-1"]])
    gen = "v2"
    await h.refetch()
    expect(h.snapshot().data?.pages).toEqual([["v2-0"], ["v2-1"]]) // both pages refetched
  })

  test("returns the same handle per key and rebinds the latest fn/opts", () => {
    const c = createQueryClient({ now: () => 0 })
    const h = c.infiniteQuery(["feed"], pager, opts)
    expect(c.infiniteQuery(["feed"], pager, opts)).toBe(h)
  })

  test("fetchPreviousPage prepends when getPreviousPageParam is provided", async () => {
    const c = createQueryClient({ now: () => 0 })
    const h = c.infiniteQuery(["feed"], (n: number) => Promise.resolve([`p${n}`]), {
      initialPageParam: 5,
      getNextPageParam: (_l: string[], _a: readonly string[][], p: number) => p + 1,
      getPreviousPageParam: (_f: string[], _a: readonly string[][], p: number) =>
        p > 0 ? p - 1 : undefined,
    })
    await h.fetch()
    expect(h.hasPreviousPage()).toBe(true)
    await h.fetchPreviousPage()
    expect(h.snapshot().data).toEqual({ pages: [["p4"], ["p5"]], pageParams: [4, 5] })
  })
})

describe("createMutation", () => {
  test("idle → pending → success, with data + variables + callback order", async () => {
    const order: string[] = []
    const m = createMutation(async (v: number) => v * 2, {
      onMutate: (v) => {
        order.push(`mutate:${v}`)
      },
      onSuccess: (d) => {
        order.push(`success:${d}`)
      },
      onSettled: (d, e) => {
        order.push(`settled:${d}:${e}`)
      },
    })
    expect(m.snapshot().status).toBe("idle")
    const p = m.mutate(21)
    expect(m.snapshot()).toMatchObject({ status: "pending", variables: 21 })
    expect(await p).toBe(42)
    expect(m.snapshot()).toMatchObject({ status: "success", data: 42, variables: 21 })
    expect(order).toEqual(["mutate:21", "success:42", "settled:42:undefined"])
  })

  test("error path sets error state and runs onError + onSettled, then reset() clears it", async () => {
    const order: string[] = []
    const boom = new Error("boom")
    const m = createMutation(
      async () => {
        throw boom
      },
      {
        onError: (e) => {
          order.push(`error:${(e as Error).message}`)
        },
        onSettled: (_d, e) => {
          order.push(`settled:${(e as Error).message}`)
        },
      },
    )
    await expect(m.mutate(undefined)).rejects.toThrow("boom")
    expect(m.snapshot()).toMatchObject({ status: "error", error: boom })
    expect(order).toEqual(["error:boom", "settled:boom"])
    m.reset()
    expect(m.snapshot().status).toBe("idle")
  })

  test("concurrent mutations: only the latest publishes state (older result dropped)", async () => {
    const g = gated()
    const m = createMutation((_v: number) => g.fn() as Promise<number>)
    const p1 = m.mutate(1)
    const p2 = m.mutate(2) // supersedes p1
    await new Promise((r) => setTimeout(r, 0)) // let both mutationFn calls register their resolvers
    g.resolve(1, 20) // resolve the SECOND call first
    g.resolve(0, 10) // then the first (older) — must not clobber
    expect(await p1).toBe(10)
    expect(await p2).toBe(20)
    expect(m.snapshot()).toMatchObject({ status: "success", data: 20, variables: 2 })
  })

  test("rebind swaps the fn without losing state", async () => {
    const m = createMutation(async (v: number) => v + 1)
    await m.mutate(1)
    expect(m.snapshot().data).toBe(2)
    m.rebind(async (v: number) => v + 100, {})
    await m.mutate(1)
    expect(m.snapshot().data).toBe(101)
  })
})
