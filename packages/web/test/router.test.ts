import { describe, expect, test } from "bun:test"
import {
  createClientRouter,
  createMatcher,
  type RouterState,
  type Submission,
} from "../src/index.ts"

describe("createMatcher", () => {
  const match = createMatcher([
    { routeId: "index", pattern: "/" },
    { routeId: "about", pattern: "/about" },
    { routeId: "user", pattern: "/users/:id" },
    { routeId: "post", pattern: "/blog/:year/:slug" },
  ])

  test("matches a static route and the index", () => {
    expect(match("/about")).toEqual({ routeId: "about", params: {} })
    expect(match("/")).toEqual({ routeId: "index", params: {} })
  })
  test("static routes beat params regardless of manifest order, matching core", () => {
    const ordered = createMatcher([
      { routeId: "user", pattern: "/users/:id" },
      { routeId: "new-user", pattern: "/users/new" },
    ])
    expect(ordered("/users/new")).toEqual({ routeId: "new-user", params: {} })
  })
  test("extracts single + multiple params", () => {
    expect(match("/users/7")).toEqual({ routeId: "user", params: { id: "7" } })
    expect(match("/blog/2026/hello")).toEqual({
      routeId: "post",
      params: { year: "2026", slug: "hello" },
    })
  })
  test("decodes percent-encoded params", () => {
    expect(match("/users/a%20b")).toEqual({ routeId: "user", params: { id: "a b" } })
  })
  test("returns null instead of throwing for malformed encoded params", () => {
    expect(match("/users/%")).toBeNull()
  })
  test("ignores the query string and matches the server's strict trailing-slash rule", () => {
    expect(match("/users/7?tab=info")).toEqual({ routeId: "user", params: { id: "7" } })
    expect(match("/users/7/")).toBeNull()
  })
  test("returns null for unmatched paths (incl. an extra segment past a :param)", () => {
    expect(match("/nope/extra/deep")).toBeNull()
    expect(match("/users/7/edit")).toBeNull() // :id is a single segment
  })

  test("matches a catch-all (*slug), capturing the rest of the path (slashes included)", () => {
    const m = createMatcher([{ routeId: "files", pattern: "/files/*path" }])
    expect(m("/files/a/b/c.txt")).toEqual({ routeId: "files", params: { path: "a/b/c.txt" } })
    expect(m("/files/one")).toEqual({ routeId: "files", params: { path: "one" } })
    expect(m("/files")).toBeNull() // a catch-all needs at least one segment
    expect(m("/files/a%20b")).toEqual({ routeId: "files", params: { path: "a b" } }) // decoded
  })

  test("a bare * catch-all uses the '*' key", () => {
    const m = createMatcher([{ routeId: "all", pattern: "/x/*" }])
    expect(m("/x/a/b")).toEqual({ routeId: "all", params: { "*": "a/b" } })
  })
})

test("mixed-route precedence matches the core router regardless of manifest order", () => {
  for (const routes of [
    [
      { routeId: "prefix", pattern: "/bar.:value" },
      { routeId: "suffix", pattern: "/:value.foo" },
    ],
    [
      { routeId: "suffix", pattern: "/:value.foo" },
      { routeId: "prefix", pattern: "/bar.:value" },
    ],
  ]) {
    const ordered = createMatcher(routes)
    expect(ordered("/bar.foo")).toEqual({ routeId: "prefix", params: { value: "foo" } })
  }
})

describe("createClientRouter", () => {
  const patterns = [
    { routeId: "index", pattern: "/" },
    { routeId: "user", pattern: "/users/:id" },
  ]
  const initial: RouterState = {
    routeId: "index",
    params: {},
    path: "/",
    data: null,
    pending: false,
  }

  test("snapshot starts at initial (stable ref); navigate publishes the matched state", async () => {
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async (_p, m) => ({ id: m.params.id }),
    })
    expect(r.snapshot()).toBe(initial) // stable reference (lets useSyncExternalStore bail)
    let notified = 0
    r.subscribe(() => {
      notified++
    })
    await r.navigate("/users/7")
    expect(notified).toBeGreaterThanOrEqual(1)
    expect(r.snapshot()).toEqual({
      routeId: "user",
      params: { id: "7" },
      path: "/users/7",
      data: { id: "7" },
      actionData: undefined,
      pending: false,
    })
  })

  test("navigate toggles pending true → false around the fetch", async () => {
    const seen: boolean[] = []
    const r = createClientRouter({ patterns, initial, fetchData: async () => ({}) })
    r.subscribe(() => seen.push(r.snapshot().pending))
    await r.navigate("/users/1")
    expect(seen).toEqual([true, false])
  })

  test("navigate publishes the target as pendingPath while in flight, cleared when settled", async () => {
    const seen: Array<string | undefined> = []
    const r = createClientRouter({ patterns, initial, fetchData: async () => ({}) })
    r.subscribe(() => seen.push(r.snapshot().pendingPath))
    await r.navigate("/users/9")
    expect(seen).toEqual(["/users/9", undefined]) // set on start, cleared on the settle publish
  })

  test("an unmatched navigate is a no-op (no notify, state unchanged)", async () => {
    let notified = 0
    const r = createClientRouter({ patterns, initial, fetchData: async () => ({}) })
    r.subscribe(() => {
      notified++
    })
    await r.navigate("/totally/unknown")
    expect(notified).toBe(0)
    expect(r.snapshot()).toBe(initial)
  })

  test("overlapping navigations apply only the latest result (race-token)", async () => {
    const delays: Record<string, number> = { "1": 30, "2": 1 } // user/1 slow, user/2 fast
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: (_p, m) =>
        new Promise((res) =>
          setTimeout(() => res({ id: m.params.id }), delays[m.params.id ?? ""] ?? 0),
        ),
    })
    await Promise.all([r.navigate("/users/1"), r.navigate("/users/2")])
    expect(r.snapshot()).toEqual({
      routeId: "user",
      params: { id: "2" },
      path: "/users/2",
      data: { id: "2" },
      actionData: undefined,
      pending: false,
    })
  })

  test("navigate awaits loadModule (code-split chunk) alongside the data fetch", async () => {
    const loaded: string[] = []
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async (_p, m) => ({ id: m.params.id }),
      loadModule: async (id) => {
        loaded.push(id)
      },
    })
    await r.navigate("/users/7")
    expect(loaded).toEqual(["user"]) // the route's chunk was requested before rendering
    expect(r.snapshot().routeId).toBe("user")
  })

  test("a failed fetch clears pending and rethrows (caller can fall back)", async () => {
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async () => {
        throw new Error("boom")
      },
    })
    await expect(r.navigate("/users/9")).rejects.toThrow("boom")
    expect(r.snapshot().pending).toBe(false)
  })

  test("unsubscribe stops notifications; match() is exposed", async () => {
    let notified = 0
    const r = createClientRouter({ patterns, initial, fetchData: async () => ({}) })
    const off = r.subscribe(() => {
      notified++
    })
    off()
    await r.navigate("/users/3")
    expect(notified).toBe(0)
    expect(r.match("/users/5")).toEqual({ routeId: "user", params: { id: "5" } })
  })

  test("the default fetchData GETs loader JSON with the X-Nifra-Data header", async () => {
    const calls: Array<{ url: string; header: string | null }> = []
    const realFetch = globalThis.fetch
    // cast: minimal fetch stub for the test — only the (url, init) shape is exercised.
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), header: new Headers(init?.headers).get("x-nifra-data") })
      return new Response(JSON.stringify({ id: "9" }), {
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    try {
      const r = createClientRouter({ patterns, initial }) // no fetchData → the default GET
      await r.navigate("/users/9")
      expect(r.snapshot().data).toEqual({ id: "9" })
      expect(calls).toEqual([{ url: "/users/9", header: "1" }])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("navigation sends retain context and merges server-retained layout slots", async () => {
    const calls: Array<Record<string, string | null>> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({
        data: headers.get("x-nifra-data"),
        from: headers.get("x-nifra-from"),
        retain: headers.get("x-nifra-retain"),
      })
      return Response.json({
        v: 1,
        data: { id: "9" },
        layoutData: [null, { project: "fresh" }],
        retained: [0],
      })
    }) as typeof fetch
    try {
      const r = createClientRouter({
        patterns,
        initial: {
          ...initial,
          layoutData: [{ shell: "kept" }, { project: "old" }],
        },
      })
      await r.navigate("/users/9")
      expect(calls).toEqual([{ data: "1", from: "/", retain: "0,1" }])
      expect(r.snapshot().layoutData).toEqual([{ shell: "kept" }, { project: "fresh" }])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("terminal status headers render the configured client boundary without rejecting navigation", async () => {
    const loaded: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 404,
        headers: { "x-nifra-status": "404" },
      })) as unknown as typeof fetch
    try {
      const r = createClientRouter({
        patterns,
        initial,
        statusRoutes: { 404: "_404" },
        loadModule: async (id) => {
          loaded.push(id)
        },
      })
      await r.navigate("/users/missing")
      expect(loaded).toEqual(["user", "_404"])
      expect(r.snapshot()).toEqual({
        routeId: "_404",
        params: {},
        path: "/users/missing",
        data: null,
        layoutData: undefined,
        actionData: undefined,
        pending: false,
      })
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("the default fetchData throws on a non-OK response", async () => {
    const realFetch = globalThis.fetch
    // cast + matching params so the stub overlaps `typeof fetch` (Bun's, with `preconnect`).
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response("nope", { status: 500 })) as typeof fetch
    try {
      const r = createClientRouter({ patterns, initial })
      await expect(r.navigate("/users/1")).rejects.toThrow(/500/)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("the default fetchData parses an x-ndjson body into data with deferred markers", async () => {
    const realFetch = globalThis.fetch
    // A deferred route streams NDJSON: line 1 (critical + placeholder) then the resolution line.
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response('{"feed":{"__nifra_deferred":0}}\n{"i":0,"v":"streamed"}\n', {
        headers: { "content-type": "application/x-ndjson" },
      })) as typeof fetch
    try {
      const r = createClientRouter({ patterns, initial })
      await r.navigate("/users/9")
      const data = r.snapshot().data as {
        feed: { __nifra_deferred: true; promise: Promise<unknown> }
      }
      expect(data.feed.__nifra_deferred).toBe(true) // a marker (returned after line 1)
      expect(await data.feed.promise).toBe("streamed") // settled by the resolution line
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("default fetchData uses static _data.json for a prerendered path (no worker) [SSG P2.4]", async () => {
    const calls: Array<{ url: string; header: string | null }> = []
    const realFetch = globalThis.fetch
    const g = globalThis as { __NIFRA_PRERENDERED__?: string[] | undefined }
    g.__NIFRA_PRERENDERED__ = ["/users/9"] // this path was prerendered
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), header: new Headers(init?.headers).get("x-nifra-data") })
      return new Response(JSON.stringify({ id: "static" }), {
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    try {
      const r = createClientRouter({ patterns, initial })
      await r.navigate("/users/9")
      expect(r.snapshot().data).toEqual({ id: "static" })
      // Fetched the static file (no x-nifra-data header) — not the dynamic worker route.
      expect(calls).toEqual([{ url: "/users/9/_data.json", header: null }])
    } finally {
      globalThis.fetch = realFetch
      g.__NIFRA_PRERENDERED__ = undefined
    }
  })

  test("default fetchData falls back to the worker when the static _data.json is missing [SSG P2.4]", async () => {
    const calls: string[] = []
    const realFetch = globalThis.fetch
    const g = globalThis as { __NIFRA_PRERENDERED__?: string[] | undefined }
    g.__NIFRA_PRERENDERED__ = ["/users/9"]
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      // static file 404s (e.g. a deferred route, or stale set) → the dynamic route answers.
      return String(url).endsWith("/_data.json")
        ? new Response("nope", { status: 404 })
        : new Response(JSON.stringify({ id: "dynamic" }), {
            headers: { "content-type": "application/json" },
          })
    }) as typeof fetch
    try {
      const r = createClientRouter({ patterns, initial })
      await r.navigate("/users/9")
      expect(r.snapshot().data).toEqual({ id: "dynamic" }) // served by the worker fallback
      expect(calls).toEqual(["/users/9/_data.json", "/users/9"]) // tried static, then fell back
    } finally {
      globalThis.fetch = realFetch
      g.__NIFRA_PRERENDERED__ = undefined
    }
  })

  test("prefetch warms the cache without publishing; navigate reuses it one-shot (no refetch)", async () => {
    let fetches = 0
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async (_p, m) => {
        fetches++
        return { id: m.params.id }
      },
    })
    let notified = 0
    r.subscribe(() => {
      notified++
    })
    await r.prefetch("/users/7")
    expect(fetches).toBe(1) // prefetch fetched the data
    expect(notified).toBe(0) // ...but published no state (no re-render)
    await r.navigate("/users/7")
    expect(fetches).toBe(1) // navigate reused the prefetched data — no second fetch
    expect(r.snapshot().data).toEqual({ id: "7" })
    await r.navigate("/users/7")
    expect(fetches).toBe(2) // one-shot: the cached entry was consumed, so this refetches
  })

  test("prefetch is a no-op when already cached or unmatched", async () => {
    let fetches = 0
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async () => {
        fetches++
        return {}
      },
    })
    await r.prefetch("/users/1")
    await r.prefetch("/users/1") // already cached → no-op
    await r.prefetch("/nope/unknown") // unmatched → no-op
    expect(fetches).toBe(1)
  })

  test("prefetch cache is bounded — evicts the oldest past the cap", async () => {
    let fetches = 0
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async (_p, m) => {
        fetches++
        return { id: m.params.id }
      },
    })
    for (let i = 0; i < 12; i++) await r.prefetch(`/users/${i}`) // cap is 10 → oldest evicted
    expect(fetches).toBe(12)
    await r.navigate("/users/0") // evicted → must refetch
    expect(fetches).toBe(13)
    await r.navigate("/users/11") // still cached → no refetch
    expect(fetches).toBe(13)
  })

  test("submit posts the action in data mode, then revalidates the active loader", async () => {
    const posts: Array<{ method: string | undefined; header: string | null }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      posts.push({ method: init?.method, header: new Headers(init?.headers).get("x-nifra-data") })
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    let loaderCalls = 0
    const r = createClientRouter({
      patterns,
      initial: {
        routeId: "user",
        params: { id: "7" },
        path: "/users/7",
        data: { n: 0 },
        pending: false,
      },
      fetchData: async () => {
        loaderCalls++
        return { n: loaderCalls } // revalidation returns fresh data
      },
    })
    try {
      await r.submit("/users/7", new URLSearchParams({ x: "1" }))
      expect(posts[0]).toEqual({ method: "POST", header: "1" }) // posted in data mode
      expect(r.snapshot().actionData).toEqual({ ok: true }) // action data published
      expect(r.snapshot().data).toEqual({ n: 1 }) // loader revalidated
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("a submit's revalidation fetch is aborted when a navigation supersedes it", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch
    let calls = 0
    let revalSignal: AbortSignal | undefined
    let releaseReval = (): void => {}
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async (_p, m, signal) => {
        calls += 1
        if (calls === 1) {
          // the submit's revalidation fetch — hang so a navigation can supersede it mid-flight
          revalSignal = signal
          await new Promise<void>((res) => {
            releaseReval = res
          })
          return {}
        }
        return { id: m.params.id } // the superseding navigation's own fetch
      },
    })
    try {
      const submitP = r.submit("/", new URLSearchParams())
      await new Promise((res) => setTimeout(res, 0)) // let the POST settle + revalidation start
      expect(revalSignal).toBeDefined()
      expect(revalSignal?.aborted).toBe(false)
      await r.navigate("/users/7") // supersede → aborts the submit's in-flight revalidation
      expect(revalSignal?.aborted).toBe(true)
      releaseReval()
      await submitP.catch(() => {})
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("fetcher.submit aborts the fetcher's prior in-flight load", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch
    let loadSignal: AbortSignal | undefined
    let releaseLoad = (): void => {}
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async (_p, _m, signal) => {
        loadSignal = signal
        await new Promise<void>((res) => {
          releaseLoad = res
        })
        return {}
      },
    })
    try {
      const f = r.fetcher("k")
      const loadP = f.load("/users/7") // hangs, capturing the load's signal
      await new Promise((res) => setTimeout(res, 0))
      expect(loadSignal?.aborted).toBe(false)
      const submitP = f.submit("/users/7", new URLSearchParams()) // supersedes the in-flight load
      expect(loadSignal?.aborted).toBe(true) // the prior load's fetch was aborted (sync, before its POST)
      releaseLoad()
      await Promise.allSettled([loadP, submitP])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("a fetcher load that FAILS doesn't set loadedPath — no spurious revalidation refetch", async () => {
    const realFetch = globalThis.fetch
    // A mutation POST that declares it changed /users/7 (the path whose load failed).
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "x-nifra-revalidate": "/users/7" },
      })) as typeof fetch
    const calls: string[] = []
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async (p) => {
        calls.push(p)
        if (p === "/users/7") throw new Error("load failed")
        return {}
      },
    })
    try {
      const failer = r.fetcher("failer")
      await expect(failer.load("/users/7")).rejects.toThrow("load failed")
      expect(calls).toEqual(["/users/7"]) // one (failed) attempt; loadedPath must stay unset

      // A different fetcher mutates and revalidates /users/7 → refreshMounted iterates ALL fetchers.
      // With the bug, `failer` (loadedPath wrongly === "/users/7") would refetch it; with the fix it
      // never showed /users/7, so it doesn't.
      await r.fetcher("mutator").submit("/things", new URLSearchParams())
      expect(calls).toEqual(["/users/7"]) // still just one — no spurious refetch by `failer`
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("submit follows an action redirect (X-Nifra-Redirect) as a client navigation", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(null, {
        status: 204,
        headers: { "x-nifra-redirect": "/users/9" },
      })) as typeof fetch
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async (_p, m) => ({ id: m.params.id }), // loads the redirect target
    })
    try {
      await r.submit("/", new URLSearchParams())
      expect(r.snapshot()).toEqual({
        routeId: "user",
        params: { id: "9" },
        path: "/users/9",
        data: { id: "9" },
        actionData: undefined,
        pending: false,
      })
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("a failed submit clears pending and rethrows", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response("nope", { status: 500 })) as typeof fetch
    const r = createClientRouter({ patterns, initial, fetchData: async () => ({}) })
    try {
      await expect(r.submit("/", new URLSearchParams())).rejects.toThrow(/500/)
      expect(r.snapshot().pending).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("submit publishes the in-flight FormData submission, then clears it on success", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch
    const r = createClientRouter({
      patterns,
      initial: {
        routeId: "user",
        params: { id: "7" },
        path: "/users/7",
        data: { items: ["a"] },
        pending: false,
      },
      fetchData: async () => ({ items: ["a", "b"] }), // revalidation adds the submitted item
    })
    // Record the submission on every publish: the first is the optimistic (pending) window.
    const submissions: Array<Submission | undefined> = []
    r.subscribe(() => submissions.push(r.snapshot().submission))
    const fd = new FormData()
    fd.set("text", "b")
    try {
      await r.submit("/users/7", fd)
    } finally {
      globalThis.fetch = realFetch
    }
    // The optimistic window exposes the submission so a component can render its expected view.
    const optimistic = submissions[0]
    expect(optimistic?.action).toBe("/users/7")
    expect(optimistic?.formData.get("text")).toBe("b")
    // Reconciled: submission cleared (real data now drives the view) + loader revalidated.
    expect(r.snapshot().submission).toBeUndefined()
    expect(r.snapshot().data).toEqual({ items: ["a", "b"] })
  })

  test("submit clears the submission on error, leaving data untouched (revert basis)", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response("nope", { status: 500 })) as typeof fetch
    const r = createClientRouter({
      patterns,
      initial: {
        routeId: "user",
        params: { id: "7" },
        path: "/users/7",
        data: { items: ["a"] },
        pending: false,
      },
      fetchData: async () => ({ items: ["a", "b"] }),
    })
    const fd = new FormData()
    fd.set("text", "b")
    try {
      await expect(r.submit("/users/7", fd)).rejects.toThrow(/500/)
    } finally {
      globalThis.fetch = realFetch
    }
    // Revert: submission gone, pending cleared, and `data` is the untouched pre-submit value — so
    // the optimistic entry vanishes and the original list shows through (no special handling).
    expect(r.snapshot().submission).toBeUndefined()
    expect(r.snapshot().pending).toBe(false)
    expect(r.snapshot().data).toEqual({ items: ["a"] })
  })

  test("submit does not expose a submission for a non-FormData body", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch
    const r = createClientRouter({
      patterns,
      initial: { routeId: "user", params: { id: "7" }, path: "/users/7", data: {}, pending: false },
      fetchData: async () => ({}),
    })
    const submissions: Array<Submission | undefined> = []
    r.subscribe(() => submissions.push(r.snapshot().submission))
    try {
      await r.submit("/users/7", new URLSearchParams({ x: "1" }))
    } finally {
      globalThis.fetch = realFetch
    }
    // URLSearchParams isn't FormData → no optimistic submission is ever published.
    expect(submissions.every((s) => s === undefined)).toBe(true)
  })

  test("submit with revalidate:false skips the loader re-fetch (data kept, actionData set)", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ created: 99 }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch
    let loaderCalls = 0
    const r = createClientRouter({
      patterns,
      initial: {
        routeId: "user",
        params: { id: "7" },
        path: "/users/7",
        data: { n: 0 },
        pending: false,
      },
      fetchData: async () => {
        loaderCalls++
        return { n: loaderCalls }
      },
    })
    try {
      await r.submit("/users/7", new URLSearchParams({ x: "1" }), { revalidate: false })
      expect(loaderCalls).toBe(0) // the active loader was NOT revalidated
      expect(r.snapshot().data).toEqual({ n: 0 }) // current data kept as-is (no re-fetch)
      expect(r.snapshot().actionData).toEqual({ created: 99 }) // the action's data still published
      expect(r.snapshot().pending).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("invalidate([active]) refetches the active loader and republishes fresh data", async () => {
    let n = 0
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async () => {
        n++
        return { v: n }
      },
    })
    await r.navigate("/users/7") // populates the cache (n=1)
    expect(r.snapshot().data).toEqual({ v: 1 })
    await r.invalidate(["/users/7"]) // active path is targeted → refetch + republish
    expect(n).toBe(2)
    expect(r.snapshot().data).toEqual({ v: 2 })
    expect(r.snapshot().pending).toBe(false)
  })

  test("invalidate() with no args refreshes the active route", async () => {
    let n = 0
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async () => {
        n++
        return { v: n }
      },
    })
    await r.navigate("/users/7") // n=1
    await r.invalidate() // invalidate-all → the active route refreshes
    expect(n).toBe(2)
    expect(r.snapshot().data).toEqual({ v: 2 })
  })

  test("invalidate([other]) marks that path stale without refetching the active route", async () => {
    let n = 0
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async () => {
        n++
        return { v: n }
      },
    })
    await r.navigate("/users/7") // n=1, active path "/users/7"
    const before = r.snapshot()
    await r.invalidate(["/users/9"]) // a different, non-active path → no active refetch
    expect(n).toBe(1) // the active loader did NOT re-run
    expect(r.snapshot()).toBe(before) // same state reference (no publish)
  })

  test("invalidate rethrows and clears pending when the active refetch fails", async () => {
    let calls = 0
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async () => {
        calls++
        if (calls > 1) throw new Error("boom")
        return { v: 1 }
      },
    })
    await r.navigate("/users/7") // calls=1 (ok)
    await expect(r.invalidate(["/users/7"])).rejects.toThrow("boom") // calls=2 → throws
    expect(r.snapshot().pending).toBe(false)
  })

  test("the keyed cache is bounded — navigating past the cap evicts without error", async () => {
    let n = 0
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async (_p, m) => {
        n++
        return { id: m.params.id }
      },
    })
    for (let i = 0; i < 55; i++) await r.navigate(`/users/${i}`) // > MAX_CACHE (50) → eviction runs
    expect(n).toBe(55)
    expect(r.snapshot().data).toEqual({ id: "54" })
  })

  test("submit: a server X-Nifra-Revalidate of the active path overrides the revalidate:false opt-out", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "x-nifra-revalidate": "/users/7" },
      })) as typeof fetch
    let loaderCalls = 0
    const r = createClientRouter({
      patterns,
      initial: {
        routeId: "user",
        params: { id: "7" },
        path: "/users/7",
        data: { n: 0 },
        pending: false,
      },
      fetchData: async () => {
        loaderCalls++
        return { n: loaderCalls }
      },
    })
    try {
      // revalidate:false would normally skip the loader, but the server explicitly listed the active
      // path as changed — so it refetches anyway (stale data would be wrong).
      await r.submit("/users/7", new URLSearchParams({ x: "1" }), { revalidate: false })
      expect(loaderCalls).toBe(1)
      expect(r.snapshot().data).toEqual({ n: 1 })
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("submit: invalid X-Nifra-Revalidate paths are dropped; valid ones honored without error", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        // "/bogus%%%" matches no manifest pattern → dropped; "/users/9" is valid → marked stale.
        headers: {
          "content-type": "application/json",
          "x-nifra-revalidate": "/bogus%%%, /users/9",
        },
      })) as typeof fetch
    let loaderCalls = 0
    const r = createClientRouter({
      patterns,
      initial: {
        routeId: "user",
        params: { id: "7" },
        path: "/users/7",
        data: { n: 0 },
        pending: false,
      },
      fetchData: async () => {
        loaderCalls++
        return { n: loaderCalls }
      },
    })
    try {
      await r.submit("/users/7", new URLSearchParams({ x: "1" })) // default revalidate
      expect(loaderCalls).toBe(1) // active revalidated; the bogus path was dropped (no crash)
      expect(r.snapshot().data).toEqual({ n: 1 })
      expect(r.snapshot().actionData).toEqual({ ok: true })
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe("fetchers (concurrent)", () => {
  const patterns = [
    { routeId: "index", pattern: "/" },
    { routeId: "user", pattern: "/users/:id" },
    { routeId: "list", pattern: "/list" },
  ]
  const initial: RouterState = {
    routeId: "index",
    params: {},
    path: "/",
    data: null,
    pending: false,
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  test("fetcher(key) returns a stable instance; fetchers() lists them", () => {
    const r = createClientRouter({ patterns, initial, fetchData: async () => ({}) })
    const a = r.fetcher("a")
    expect(r.fetcher("a")).toBe(a) // same key → same instance
    const b = r.fetcher("b")
    expect(r.fetchers()).toEqual([a, b])
  })

  test("two fetchers load concurrently, each settling to its own data (no clobber)", async () => {
    const delays: Record<string, number> = { "/users/1": 40, "/users/2": 5 }
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async (path) => {
        await sleep(delays[path] ?? 0)
        return { p: path }
      },
    })
    const fa = r.fetcher("a")
    const fb = r.fetcher("b")
    const pa = fa.load("/users/1") // slow
    const pb = fb.load("/users/2") // fast
    expect(fa.snapshot().pending).toBe(true)
    expect(fb.snapshot().pending).toBe(true)
    await Promise.all([pa, pb])
    expect(fa.snapshot().data).toEqual({ p: "/users/1" })
    expect(fb.snapshot().data).toEqual({ p: "/users/2" })
    expect(fa.snapshot().pending).toBe(false)
  })

  test("a fetcher load is single-flight against itself (latest dispatched wins)", async () => {
    const delays: Record<string, number> = { "/users/1": 40, "/users/2": 5 }
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async (path) => {
        await sleep(delays[path] ?? 0)
        return { p: path }
      },
    })
    const f = r.fetcher("x")
    const p1 = f.load("/users/1") // token 1 (slow)
    const p2 = f.load("/users/2") // token 2 (fast) — supersedes
    await Promise.all([p1, p2])
    expect(f.snapshot().data).toEqual({ p: "/users/2" }) // the slow token-1 result was dropped
  })

  test("a fetcher load to an unmatched path is a no-op", async () => {
    let calls = 0
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async () => {
        calls++
        return {}
      },
    })
    const f = r.fetcher("x")
    await f.load("/totally/unknown")
    expect(calls).toBe(0)
    expect(f.snapshot().pending).toBe(false)
  })

  test("a fetcher load failure clears pending and rethrows", async () => {
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async () => {
        throw new Error("boom")
      },
    })
    const f = r.fetcher("x")
    await expect(f.load("/list")).rejects.toThrow("boom")
    expect(f.snapshot().pending).toBe(false)
  })

  test("fetcher.submit publishes its own actionData + exposes the in-flight submission", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_u: string, _i?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch
    const r = createClientRouter({ patterns, initial, fetchData: async () => ({}) })
    const f = r.fetcher("x")
    const seen: Array<ReturnType<typeof f.snapshot>> = []
    const off = f.subscribe(() => seen.push(f.snapshot()))
    const fd = new FormData()
    fd.set("text", "hi")
    try {
      await f.submit("/list", fd)
      expect(seen[0]?.pending).toBe(true)
      expect(seen[0]?.submission?.formData.get("text")).toBe("hi") // optimistic submission exposed
      expect(f.snapshot().actionData).toEqual({ ok: true })
      expect(f.snapshot().submission).toBeUndefined() // cleared on settle
      expect(f.snapshot().pending).toBe(false)
      const settled = seen.length
      off() // unsubscribe stops further notifications
      await f.load("/list")
      expect(seen.length).toBe(settled)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("fetcher.submit honors X-Nifra-Revalidate: refreshes the active route + a mounted fetcher", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_u: string, _i?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "x-nifra-revalidate": "/list,/users/7" },
      })) as typeof fetch
    let loaderCalls = 0
    const r = createClientRouter({
      patterns,
      initial: { routeId: "list", params: {}, path: "/list", data: { v: 0 }, pending: false },
      fetchData: async (path) => {
        loaderCalls++
        return { path }
      },
    })
    const viewer = r.fetcher("viewer")
    await viewer.load("/users/7") // loaderCalls=1
    const mutator = r.fetcher("mutator") // never loads → its refreshIfShowing is a no-op
    try {
      await mutator.submit("/list", new URLSearchParams({ x: "1" }))
      expect(loaderCalls).toBe(3) // active /list + viewer /users/7 both refreshed (1 + 2)
      expect(r.snapshot().data).toMatchObject({ path: "/list" }) // active refreshed
      expect(viewer.snapshot().data).toMatchObject({ path: "/users/7" }) // viewer refreshed
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("a fetcher submit failure clears pending and rethrows", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_u: string, _i?: RequestInit) =>
      new Response("nope", { status: 500 })) as typeof fetch
    const r = createClientRouter({ patterns, initial, fetchData: async () => ({}) })
    const f = r.fetcher("x")
    try {
      await expect(f.submit("/list", new URLSearchParams())).rejects.toThrow(/500/)
      expect(f.snapshot().pending).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("a fetcher submit is single-flight against itself (a superseding load drops it)", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_u: string, _i?: RequestInit) => {
      await sleep(40)
      return new Response(JSON.stringify({ ok: "slow" }), {
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    const r = createClientRouter({ patterns, initial, fetchData: async () => ({ id: "loaded" }) })
    const f = r.fetcher("x")
    try {
      const pSubmit = f.submit("/list", new URLSearchParams()) // fToken 1 (slow POST)
      const pLoad = f.load("/users/7") // fToken 2 — supersedes
      await Promise.all([pSubmit, pLoad])
      expect(f.snapshot().data).toEqual({ id: "loaded" }) // the load won
      expect(f.snapshot().actionData).toBeUndefined() // the superseded submit dropped its result
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("router.submit refreshes a mounted fetcher showing a changed (non-active) route", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_u: string, _i?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "x-nifra-revalidate": "/users/9" },
      })) as typeof fetch
    let loaderCalls = 0
    const r = createClientRouter({
      patterns,
      initial: { routeId: "list", params: {}, path: "/list", data: { v: 0 }, pending: false },
      fetchData: async (path) => {
        loaderCalls++
        return { path }
      },
    })
    const viewer = r.fetcher("viewer")
    await viewer.load("/users/9") // loaderCalls=1
    try {
      await r.submit("/list", new URLSearchParams({ x: "1" })) // active /list revalidates; /users/9 → viewer
      expect(viewer.snapshot().data).toMatchObject({ path: "/users/9" }) // viewer refreshed
      expect(loaderCalls).toBe(3) // 1 (load) + active /list + viewer /users/9
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("invalidate refreshes a fetcher showing a targeted path and skips a non-matching one", async () => {
    let loaderCalls = 0
    const r = createClientRouter({
      patterns,
      initial,
      fetchData: async (path) => {
        loaderCalls++
        return { path }
      },
    })
    const showsList = r.fetcher("a")
    await showsList.load("/list") // loaderCalls=1
    const showsUser = r.fetcher("b")
    await showsUser.load("/users/7") // loaderCalls=2
    await r.invalidate(["/list"]) // only /list is targeted (active is "/", not in scope)
    expect(loaderCalls).toBe(3) // only showsList refetched
    expect(showsList.snapshot().data).toMatchObject({ path: "/list" })
  })

  test("an invalidate refetch superseded by a navigation drops its result", async () => {
    const delays: Record<string, number> = { "/list": 40, "/users/7": 5 }
    const r = createClientRouter({
      patterns,
      initial: { routeId: "list", params: {}, path: "/list", data: { v: 0 }, pending: false },
      fetchData: async (path) => {
        await sleep(delays[path] ?? 0)
        return { path }
      },
    })
    const pInval = r.invalidate(["/list"]) // refetchActive /list (slow, token 1)
    const pNav = r.navigate("/users/7") // token 2 — supersedes
    await Promise.all([pInval, pNav])
    expect(r.snapshot().path).toBe("/users/7") // the navigation won
    expect(r.snapshot().data).toEqual({ path: "/users/7" })
  })

  test("subscribeFetchers fires on creation + change; unsubscribe stops it", async () => {
    const r = createClientRouter({ patterns, initial, fetchData: async () => ({ ok: 1 }) })
    let fires = 0
    const unsub = r.subscribeFetchers(() => {
      fires++
    })
    const f = r.fetcher("x") // creation fires
    expect(fires).toBe(1)
    await f.load("/list") // pending + settle fire
    expect(fires).toBeGreaterThan(1)
    const snapshot = fires
    unsub()
    await r.fetcher("y").load("/list") // unsubscribed → no more fires
    expect(fires).toBe(snapshot)
  })

  test("a fetcher submit's targeted refresh is best-effort — a failing cross-refresh won't fail it", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_u: string, _i?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "x-nifra-revalidate": "/list,/users/7" },
      })) as typeof fetch
    let calls = 0
    const r = createClientRouter({
      patterns,
      initial: { routeId: "list", params: {}, path: "/list", data: { v: 0 }, pending: false },
      fetchData: async () => {
        calls++
        if (calls > 1) throw new Error("refresh-fail") // every refresh after the first load fails
        return { ok: 1 }
      },
    })
    const viewer = r.fetcher("viewer")
    await viewer.load("/users/7") // calls=1 (ok)
    const mutator = r.fetcher("mutator")
    try {
      // The header triggers refreshes of the active route + the viewer; both fetchData calls throw,
      // but those are swallowed (best-effort) so the submit itself still resolves successfully.
      await mutator.submit("/list", new URLSearchParams())
      expect(mutator.snapshot().actionData).toEqual({ ok: true })
      expect(mutator.snapshot().pending).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("two fetchers submit concurrently, each pending then settling to its own actionData", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_u: string, _i?: RequestInit) => {
      await sleep(40)
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" }, // no revalidate header → no cross-refresh
      })
    }) as typeof fetch
    const r = createClientRouter({ patterns, initial, fetchData: async () => ({}) })
    const fa = r.fetcher("a")
    const fb = r.fetcher("b")
    try {
      const pa = fa.submit("/list", new URLSearchParams())
      const pb = fb.submit("/list", new URLSearchParams())
      expect(fa.snapshot().pending).toBe(true) // both in flight at once — independent state machines
      expect(fb.snapshot().pending).toBe(true)
      await Promise.all([pa, pb])
      expect(fa.snapshot().actionData).toEqual({ ok: true })
      expect(fb.snapshot().actionData).toEqual({ ok: true })
      expect(fa.snapshot().pending).toBe(false)
      expect(fb.snapshot().pending).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
