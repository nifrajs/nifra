/** Queries with live keys: registration while mounted, refresh, the tick a fetch asked at, and clear. */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { IDENTITY_CHANNEL, identityChanged } from "../src/identity.ts"
import {
  advanceLiveTick,
  clearQueryClients,
  type LiveQuery,
  liveQueries,
  liveTick,
  registeredAt,
  watchLiveQueries,
} from "../src/internal/live-queries.ts"
import { installQuerySeam, queryClients, querySeam } from "../src/internal/query-seam.ts"
import { createMutation, createQueryClient } from "../src/query.ts"

function gated() {
  const resolvers: ((value: unknown) => void)[] = []
  const rejecters: ((error: unknown) => void)[] = []
  const fn = () =>
    new Promise<unknown>((resolve, reject) => {
      resolvers.push(resolve)
      rejecters.push(reject)
    })
  return {
    fn,
    calls: () => resolvers.length,
    resolve: (i: number, value: unknown) => resolvers[i]?.(value),
    reject: (i: number, error: unknown) => rejecters[i]?.(error),
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the identity broadcast")
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
const only = (): LiveQuery => {
  const [query, ...rest] = [...liveQueries()]
  if (query === undefined || rest.length > 0) throw new Error(`expected one live query`)
  return query
}

let hadWindow = false
beforeEach(() => {
  hadWindow = Reflect.has(globalThis, "window")
  if (!hadWindow) Reflect.set(globalThis, "window", globalThis)
})
afterEach(() => {
  if (!hadWindow) Reflect.deleteProperty(globalThis, "window")
  expect([...liveQueries()].length).toBe(0)
})

test("a query registers while mounted with live keys, and only then", () => {
  const c = createQueryClient({ now: () => 0 })
  const plain = c.query(["plain"], async () => 1)
  const off = plain.subscribe(() => {})
  expect([...liveQueries()].length).toBe(0)
  off()

  const handle = c.query(["post", 1], async () => 1, { live: ["post:1"] })
  expect([...liveQueries()].length).toBe(0)
  const first = handle.subscribe(() => {})
  const second = handle.subscribe(() => {})
  expect(only().keys()).toEqual(["post:1"])
  first()
  expect([...liveQueries()].length).toBe(1)
  second()
  expect([...liveQueries()].length).toBe(0)
})

test("new keys on a re-bind tell the live client; the same keys in a new array do not", () => {
  const c = createQueryClient({ now: () => 0 })
  let told = 0
  const unwatch = watchLiveQueries(() => told++)
  const off = c.query(["post", 1], async () => 1, { live: ["post:1"] }).subscribe(() => {})
  expect(told).toBe(1)
  c.query(["post", 1], async () => 1, { live: ["post:1"] })
  expect(told).toBe(1)
  // It registers again, at a later tick: a change to the new key before now never reached it.
  const first = registeredAt(only())
  c.query(["post", 1], async () => 1, { live: ["post:1", "comments:1"] })
  expect(told).toBe(3)
  expect(registeredAt(only())).toBeGreaterThan(first ?? Number.POSITIVE_INFINITY)
  expect(only().keys()).toEqual(["post:1", "comments:1"])
  // A render that names no keys drops them, and the query leaves the registry.
  c.query(["post", 1], async () => 1)
  expect([...liveQueries()].length).toBe(0)
  // A write or prefetch that names none keeps what the last render named.
  c.query(["post", 1], async () => 1, { live: ["post:1"] })
  c.setQueryData(["post", 1], 2)
  expect([...liveQueries()].length).toBe(1)
  off()
  unwatch()
})

test("tick is the start of the fetch in flight, else of the fetch that produced the data", async () => {
  const g = gated()
  const c = createQueryClient({ now: () => 0 })
  const handle = c.query(["k"], g.fn, { live: ["k:1"] })
  const off = handle.subscribe(() => {})
  const query = only()
  const before = liveTick()
  void handle.fetch()
  expect(query.tick()).toBe(before)
  const arrived = advanceLiveTick()
  expect(query.tick()).toBe(before)
  g.resolve(0, "a")
  await flush()
  // The data was asked for before the load arrived.
  expect(query.tick()).toBeLessThan(arrived)
  void handle.refetch()
  expect(query.tick()).toBe(arrived)
  g.resolve(1, "b")
  await flush()
  expect(query.tick()).toBe(arrived)
  // A failed fetch leaves the tick of the data still shown.
  advanceLiveTick()
  const failing = handle.refetch().catch(() => {})
  g.reject(2, new Error("down"))
  await failing
  expect(query.tick()).toBe(arrived)
  off()
})

test("refresh supersedes a fetch in flight: its old answer never publishes", async () => {
  const g = gated()
  const c = createQueryClient({ now: () => 0 })
  const handle = c.query(["k"], g.fn, { live: ["k:1"] })
  const off = handle.subscribe(() => {})
  void handle.fetch()
  only().refresh()
  expect(g.calls()).toBe(2)
  g.resolve(1, "new")
  g.resolve(0, "old")
  await flush()
  expect(handle.snapshot().data).toBe("new")
  off()
})

test("hydrated data counts as read before any live load", () => {
  const c = createQueryClient({ now: () => 0 })
  advanceLiveTick()
  c.hydrate({ queries: [{ key: ["k"], data: 1, updatedAt: 1 }] })
  const off = c.query(["k"], async () => 1, { live: ["k:1"] }).subscribe(() => {})
  expect(only().tick()).toBe(0)
  c.setQueryData(["k"], 2)
  expect(only().tick()).toBe(liveTick())
  off()
})

test("clear drops unmounted queries and sends mounted ones back to pending, refetching", async () => {
  const g = gated()
  const c = createQueryClient({ now: () => 0 })
  c.setQueryData(["gone"], "theirs")
  const handle = c.query(["shown"], g.fn)
  const seen: unknown[] = []
  const off = handle.subscribe(() => seen.push(handle.snapshot().status))
  void handle.fetch()
  g.resolve(0, "theirs")
  await flush()
  void handle.refetch()
  c.clear()
  expect(c.getQueryData(["gone"])).toBeUndefined()
  expect(handle.snapshot().data).toBeUndefined()
  expect(handle.snapshot().isFetching).toBe(true)
  expect(g.calls()).toBe(3)
  // The fetch begun before the clear carried the last viewer's credentials.
  g.resolve(1, "theirs again")
  g.resolve(2, "mine")
  await flush()
  expect(handle.snapshot().data).toBe("mine")
  expect(seen).toContain("pending")
  off()
})

test("clear also resets infinite queries and drops snapshots still waiting to seed", async () => {
  const pages = gated()
  const c = createQueryClient({ now: () => 0 })
  const opts = {
    initialPageParam: 0,
    getNextPageParam: (_: unknown, all: readonly unknown[]) => all.length,
  }
  const handle = c.infiniteQuery(["feed"], pages.fn, opts)
  const off = handle.subscribe(() => {})
  void handle.fetch()
  pages.resolve(0, "page-0")
  await flush()
  void handle.fetchNextPage()
  pages.resolve(1, "page-1")
  await flush()
  expect(handle.snapshot().data?.pages).toEqual(["page-0", "page-1"])
  c.hydrate({
    queries: [],
    infiniteQueries: [{ key: ["later"], data: { pages: ["x"], pageParams: [0] }, updatedAt: 1 }],
  })
  c.infiniteQuery(["unmounted"], async () => "u", opts)
  c.clear()
  expect(handle.snapshot().status).toBe("pending")
  pages.resolve(2, "mine-0")
  await flush()
  expect(handle.snapshot().data?.pages).toEqual(["mine-0"])
  expect(c.infiniteQuery(["later"], async () => "y", opts).snapshot().status).toBe("pending")
  off()
})

test("an infinite query with live keys registers while mounted and refreshes every page", async () => {
  const pages = gated()
  const c = createQueryClient({ now: () => 0 })
  const opts = {
    initialPageParam: 0,
    getNextPageParam: (_: unknown, all: readonly unknown[]) => all.length,
    live: ["feed"],
  }
  const handle = c.infiniteQuery(["feed"], pages.fn, opts)
  const off = handle.subscribe(() => {})
  void handle.fetch()
  const query = only()
  expect(query.keys()).toEqual(["feed"])
  const started = liveTick()
  expect(query.tick()).toBe(started)
  pages.resolve(0, "a")
  await flush()
  const arrived = advanceLiveTick()
  expect(query.tick()).toBeLessThan(arrived)
  query.refresh()
  expect(query.tick()).toBe(arrived)
  pages.resolve(1, "b")
  await flush()
  expect(handle.snapshot().data?.pages).toEqual(["b"])
  let told = 0
  const unwatch = watchLiveQueries(() => told++)
  c.infiniteQuery(["feed"], pages.fn, { ...opts, live: ["feed"] })
  expect(told).toBe(0)
  c.infiniteQuery(["feed"], pages.fn, { ...opts, live: ["feed", "feed:new"] })
  expect(told).toBe(2)
  c.infiniteQuery(["feed"], pages.fn, { ...opts, live: [] })
  expect([...liveQueries()].length).toBe(0)
  c.infiniteQuery(["feed"], pages.fn, opts)
  expect([...liveQueries()].length).toBe(1)
  off()
  unwatch()
})

test("a viewer switch clears every query client the page made, and no server-side one", async () => {
  const mine = createQueryClient({ now: () => 0 })
  mine.setQueryData(["k"], "theirs")
  Reflect.deleteProperty(globalThis, "window")
  const serverSide = createQueryClient({ now: () => 0 })
  serverSide.setQueryData(["k"], "request-scoped")
  Reflect.set(globalThis, "window", globalThis)
  clearQueryClients()
  expect(mine.getQueryData(["k"])).toBeUndefined()
  expect(serverSide.getQueryData(["k"])).toBe("request-scoped")
})

test("identityChanged() clears every query client the page made, and no server-side one", () => {
  const mine = createQueryClient({ now: () => 0 })
  mine.setQueryData(["k"], "theirs")
  Reflect.deleteProperty(globalThis, "window")
  const serverSide = createQueryClient({ now: () => 0 })
  serverSide.setQueryData(["k"], "request-scoped")
  Reflect.set(globalThis, "window", globalThis)
  identityChanged()
  expect(mine.getQueryData(["k"])).toBeUndefined()
  expect(serverSide.getQueryData(["k"])).toBe("request-scoped")
})

test("a remote identity broadcast clears query data and cancels a pending mutation", async () => {
  const client = createQueryClient({ now: () => 0 })
  client.setQueryData(["profile"], { name: "Previous visitor" })

  let resolveMutation!: (value: string) => void
  let signal: AbortSignal | undefined
  let successCalled = false
  const mutation = createMutation(
    (_variables: undefined, context) => {
      signal = context.signal
      return new Promise<string>((resolve) => {
        resolveMutation = resolve
      })
    },
    {
      onSuccess: () => {
        successCalled = true
      },
    },
  )
  const pending = mutation.mutate(undefined)
  void pending.catch(() => {})
  expect(signal?.aborted).toBe(false)

  const otherTab = new BroadcastChannel(IDENTITY_CHANNEL)
  try {
    otherTab.postMessage("changed")
    await waitFor(() => client.getQueryData(["profile"]) === undefined)
    expect(signal?.aborted).toBe(true)

    await expect(pending).rejects.toMatchObject({ name: "MutationCancelledError" })
    expect(mutation.snapshot().status).toBe("idle")
    expect(successCalled).toBe(false)
    resolveMutation("late result")
  } finally {
    otherTab.close()
  }
})

// A sign-in or sign-out response rotates the document's identity epoch, in a task of its own.
const withEpoch = async (
  run: (rotate: (epoch: string) => Promise<void>) => Promise<void>,
): Promise<void> => {
  const described = Object.getOwnPropertyDescriptor(globalThis, "document")
  const cookies = { cookie: "nifra-epoch=one" }
  Object.defineProperty(globalThis, "document", { value: cookies, configurable: true })
  try {
    await run(async (epoch) => {
      await Promise.resolve()
      cookies.cookie = `nifra-epoch=${epoch}`
    })
  } finally {
    if (described === undefined) Reflect.deleteProperty(globalThis, "document")
    else Object.defineProperty(globalThis, "document", described)
  }
}
const firstPage = { initialPageParam: 0, getNextPageParam: () => undefined }

test("a new identity epoch drops a client's data on its next read, and mounted queries refetch after it", async () => {
  await withEpoch(async (rotate) => {
    const c = createQueryClient({ now: () => 0 })
    let who = "first"
    const one = c.query(["me"], async () => who)
    const feed = c.infiniteQuery(["feed"], async () => who, firstPage)
    await Promise.all([one.fetch(), feed.fetch()])
    c.hydrate({
      queries: [],
      infiniteQueries: [
        { key: ["seeded"], data: { pages: ["first"], pageParams: [0] }, updatedAt: 0 },
      ],
    })
    let told = 0
    const offs = [one.subscribe(() => told++), feed.subscribe(() => told++)]
    who = "second"
    await rotate("two")
    // Read while a component renders: its subscribers hear once the render is over.
    expect(c.getQueryData(["me"])).toBeUndefined()
    expect([one.snapshot().status, feed.snapshot().status, told]).toEqual(["pending", "pending", 0])
    expect(c.infiniteQuery(["seeded"], async () => who, firstPage).snapshot().status).toBe(
      "pending",
    )
    await flush()
    expect(told).toBeGreaterThan(0)
    expect([one.snapshot().data, feed.snapshot().data?.pages]).toEqual(["second", ["second"]])
    for (const off of offs) off()
  })
})

test("a fetch in flight when the epoch changes never publishes", async () => {
  await withEpoch(async (rotate) => {
    const c = createQueryClient({ now: () => 0 })
    const g = gated()
    const handle = c.query(["me"], g.fn)
    const off = handle.subscribe(() => {})
    void handle.fetch()
    await rotate("two")
    c.query(["me"], g.fn)
    g.resolve(0, "first")
    await flush()
    expect(handle.snapshot().data).toBeUndefined()
    g.resolve(1, "second")
    await flush()
    expect(handle.snapshot().data).toBe("second")
    off()
  })
})

test("a held handle's read after a new epoch shows the fetch it starts, which the mounted refetch joins", async () => {
  await withEpoch(async (rotate) => {
    const c = createQueryClient({ now: () => 0, staleTime: Number.POSITIVE_INFINITY })
    const g = gated()
    const one = c.query(["me"], g.fn)
    const feed = c.infiniteQuery(["feed"], g.fn, firstPage)
    const offs = [one.subscribe(() => {}), feed.subscribe(() => {})]
    void one.fetch()
    void feed.fetch()
    g.resolve(0, "first")
    g.resolve(1, "first")
    await flush()
    await rotate("two")
    void one.fetch()
    void feed.fetch()
    await flush()
    expect([one.snapshot(), feed.snapshot()].map((s) => [s.status, s.isFetching])).toEqual([
      ["pending", true],
      ["pending", true],
    ])
    expect(g.calls()).toBe(4)
    g.resolve(2, "second")
    g.resolve(3, "second")
    await flush()
    expect([one.snapshot().data, feed.snapshot().data?.pages]).toEqual(["second", ["second"]])
    for (const off of offs) off()
  })
})

test("a new epoch while a change's reloads run loads them once more, and one after that is theirs", async () => {
  await withEpoch(async (rotate) => {
    const c = createQueryClient({ now: () => 0 })
    const g = gated()
    const pages = gated()
    const one = c.query(["me"], g.fn)
    const feed = c.infiniteQuery(["feed"], pages.fn, firstPage)
    const offs = [one.subscribe(() => {}), feed.subscribe(() => {})]
    void one.fetch()
    void feed.fetch()
    g.resolve(0, "first")
    pages.resolve(0, "first")
    await flush()
    await rotate("two")
    one.snapshot()
    await flush()
    expect([g.calls(), pages.calls()]).toEqual([2, 2])
    // Another tab's sign-in lands while the reloads run.
    await rotate("three")
    g.resolve(1, "second")
    pages.resolve(1, "second")
    await flush()
    expect([g.calls(), pages.calls(), one.snapshot().status, feed.snapshot().status]).toEqual([
      3,
      3,
      "pending",
      "pending",
    ])
    await rotate("four")
    g.resolve(2, "third")
    pages.resolve(2, "third")
    await flush()
    expect([one.snapshot().data, feed.snapshot().data?.pages, g.calls(), pages.calls()]).toEqual([
      "third",
      ["third"],
      3,
      3,
    ])
    for (const off of offs) off()
  })
})

test("a handle kept past its last subscriber reads nothing of the previous visitor", async () => {
  const c = createQueryClient({ now: () => 0, staleTime: Number.POSITIVE_INFINITY })
  let who = "first"
  const held = c.query(["me"], async () => who)
  await held.fetch()
  c.clear()
  who = "second"
  expect(held.snapshot().status).toBe("pending")
  expect(await held.fetch()).toBe("second")
})

test("the registry lets go of query clients the page dropped", async () => {
  for (let i = 0; i < 40; i++) createQueryClient({ now: () => 0 }).setQueryData(["k"], i)
  // A WeakRef holds its target until the job that made it ends.
  await new Promise((resolve) => setImmediate(resolve))
  Bun.gc(true)
  const kept = createQueryClient({ now: () => 0 })
  expect([...queryClients()].filter((ref) => ref.deref() === undefined)).toEqual([])
  kept.setQueryData(["k"], 1)
  clearQueryClients()
  expect(kept.getQueryData(["k"])).toBeUndefined()
})

test("a refetch that fails after clear is let go: the query shows the error", async () => {
  const g = gated()
  const pages = gated()
  const c = createQueryClient({ now: () => 0 })
  const handle = c.query(["k"], g.fn)
  const feed = c.infiniteQuery(["feed"], pages.fn, {
    initialPageParam: 0,
    getNextPageParam: () => undefined,
  })
  const offPlain = handle.subscribe(() => {})
  const offFeed = feed.subscribe(() => {})
  c.clear()
  g.reject(0, new Error("down"))
  pages.reject(0, new Error("down"))
  await flush()
  expect(handle.snapshot().status).toBe("error")
  expect(feed.snapshot().status).toBe("error")
  offPlain()
  offFeed()
})

test("a fetch a visitor change catches answers with what the reload the change started showed", async () => {
  const g = gated()
  const pages = gated()
  const c = createQueryClient({ now: () => 0 })
  const handle = c.query(["k"], g.fn)
  const feed = c.infiniteQuery(["feed"], pages.fn, firstPage)
  const offs = [handle.subscribe(() => {}), feed.subscribe(() => {})]
  const caught = handle.fetch()
  const caughtFeed = feed.fetch()
  c.clear()
  g.resolve(1, "mine")
  pages.resolve(1, "mine")
  await flush()
  g.resolve(0, "theirs")
  pages.resolve(0, "theirs")
  expect(await caught).toBe("mine")
  expect((await caughtFeed).pages).toEqual(["mine"])
  expect([g.calls(), pages.calls()]).toEqual([2, 2])
  for (const off of offs) off()
})

test("a fetch a visitor change catches rejects with a later load's failure for the new visitor", async () => {
  const g = gated()
  const pages = gated()
  const c = createQueryClient({ now: () => 0 })
  const handle = c.query(["k"], g.fn)
  const feed = c.infiniteQuery(["feed"], pages.fn, firstPage)
  const offs = [handle.subscribe(() => {}), feed.subscribe(() => {})]
  const caught = handle.fetch().then(
    () => undefined,
    (error: unknown) => error,
  )
  const caughtFeed = feed.fetch().then(
    () => undefined,
    (error: unknown) => error,
  )
  c.clear()
  g.resolve(1, "mine")
  pages.resolve(1, "mine")
  await flush()
  void handle.refetch().catch(() => {})
  void feed.refetch().catch(() => {})
  const down = new Error("down")
  g.reject(2, down)
  pages.reject(2, down)
  await flush()
  g.resolve(0, "theirs")
  pages.resolve(0, "theirs")
  expect(await caught).toBe(down)
  expect(await caughtFeed).toBe(down)
  expect([handle.snapshot().error, feed.snapshot().error]).toEqual([down, down])
  expect([g.calls(), pages.calls()]).toEqual([3, 3])
  for (const off of offs) off()
})

test("an infinite fetch a change catches with no reload under way loads again, on a handle the cache let go of too", async () => {
  let t = 0
  const kept = gated()
  const gone = gated()
  const c = createQueryClient({ now: () => t, gcTime: 10 })
  const keptFeed = c.infiniteQuery(["kept"], kept.fn, firstPage)
  const goneFeed = c.infiniteQuery(["gone"], gone.fn, firstPage)
  goneFeed.subscribe(() => {})()
  const caughtKept = keptFeed.fetch()
  const caughtGone = goneFeed.fetch()
  t = 20
  expect(c.infiniteQuery(["gone"], gone.fn, firstPage)).not.toBe(goneFeed)
  c.clear()
  kept.resolve(0, "theirs")
  gone.resolve(0, "theirs")
  await flush()
  kept.resolve(1, "mine")
  gone.resolve(1, "mine")
  expect((await caughtKept).pages).toEqual(["mine"])
  expect((await caughtGone).pages).toEqual(["mine"])
})

/** Run `body` as a page does before its live client has loaded: no seam installed yet. */
async function beforeLiveClient(body: () => void | Promise<void>): Promise<void> {
  const seam = querySeam()
  if (seam === undefined) throw new Error("the live client's seam is not installed")
  Reflect.deleteProperty(globalThis, Symbol.for("nifra.web.querySeam"))
  try {
    await body()
  } finally {
    installQuerySeam(seam)
  }
}

test("clients the page made before its live client loaded, and never used again, are cleared too", async () => {
  const early: ReturnType<typeof createQueryClient>[] = []
  await beforeLiveClient(() => {
    for (const viewer of ["viewer-1's", "viewer-1's other"]) {
      const client = createQueryClient({ now: () => 0 })
      client.setQueryData(["account"], viewer)
      early.push(client)
    }
  })
  clearQueryClients()
  expect(early.map((client) => client.getQueryData(["account"]))).toEqual([undefined, undefined])
})

test("a server-side client made before the live client loaded is never held", async () => {
  let serverSide: ReturnType<typeof createQueryClient> | undefined
  await beforeLiveClient(() => {
    Reflect.deleteProperty(globalThis, "window")
    try {
      serverSide = createQueryClient({ now: () => 0 })
      serverSide.setQueryData(["k"], "request-scoped")
    } finally {
      Reflect.set(globalThis, "window", globalThis)
    }
  })
  clearQueryClients()
  expect(serverSide?.getQueryData(["k"])).toBe("request-scoped")
})
