import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { BoundaryState } from "../src/boundary.ts"
import { identityChanged, onIdentityChange } from "../src/identity.ts"
import { keepAliveTable, slotDepths } from "../src/internal/keep-alive-table.ts"
import {
  checkSlotCss,
  createSlotParking,
  type KeepAliveClientOptions,
  type KeepAliveDropReason,
  type KeepAliveRouter,
  keepAliveClient,
  PAGE_HIDE_EVENT,
  PAGE_SHOW_EVENT,
  type SlotNode,
  slotTree,
} from "../src/keep-alive.ts"
import { buildManifest, type ClientRouteHooks, type RouteModule } from "../src/manifest.ts"
import type { MatchChain } from "../src/render-seam.ts"
import {
  type ClientRouter,
  createClientRouter,
  type Fetcher,
  type FetchRouteData,
  type RouteMatch,
  type RouterState,
} from "../src/router.ts"

// ---- a browser stand-in: history entries, the cookie jar and other tabs -------------------------

class FakeHistory {
  entries: Record<string, unknown>[] = [{ nifraIndex: 0 }]
  at = 0
  get state(): Record<string, unknown> | undefined {
    return this.entries[this.at]
  }
  replaceState(state: Record<string, unknown>): void {
    this.entries[this.at] = state
  }
  /** A link or form: `installHistory` pushes a fresh entry before it navigates. */
  push(): void {
    this.entries.splice(this.at + 1)
    this.at++
    this.entries.push({ nifraIndex: this.at })
  }
  /** A replace navigation rewrites the entry on screen without an instance. */
  replace(): void {
    this.entries[this.at] = { nifraIndex: this.at }
  }
  go(delta: number): void {
    this.at += delta
  }
}

class FakeChannel {
  static open: FakeChannel[] = []
  readonly sent: unknown[] = []
  readonly #listeners = new Set<() => void>()
  constructor(readonly name: string) {
    FakeChannel.open.push(this)
  }
  addEventListener(_type: "message", listener: () => void): void {
    this.#listeners.add(listener)
  }
  postMessage(message: unknown): void {
    this.sent.push(message)
    for (const other of FakeChannel.open)
      if (other !== this && other.name === this.name) other.receive()
  }
  receive(): void {
    for (const listener of [...this.#listeners]) listener()
  }
  close(): void {}
}

// Restored as they were: a `document` left defined, even as undefined, turns off code generation
// in the output guard for every later test in the process.
const saved = ["history", "document", "BroadcastChannel"].map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
)
// The value at `path` inside `value`, or undefined where a step is not an object.
const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (step, key) => (typeof step === "object" && step !== null ? Reflect.get(step, key) : undefined),
    value,
  )
let fakeHistory: FakeHistory
let fakeDocument: {
  cookie: string
  visibilityState: string
  activeElement: unknown
  styleSheets: unknown[]
}
beforeEach(() => {
  fakeHistory = new FakeHistory()
  fakeDocument = { cookie: "", visibilityState: "visible", activeElement: null, styleSheets: [] }
  Reflect.set(globalThis, "history", fakeHistory)
  Reflect.set(globalThis, "document", fakeDocument)
  Reflect.set(globalThis, "BroadcastChannel", FakeChannel)
  FakeChannel.open = []
})
afterEach(() => {
  for (const [name, descriptor] of saved)
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
    else Object.defineProperty(globalThis, name, descriptor)
})

// ---- the router under the layer -----------------------------------------------------------------

const state = (routeId: string, path: string, extra: Partial<RouterState> = {}): RouterState => ({
  routeId,
  path,
  params: {},
  data: { path },
  pending: false,
  ...extra,
})

const fetcherStub = (): Fetcher & { submitted: number } => {
  const fetcher = {
    submitted: 0,
    snapshot: () => ({ pending: false, data: undefined }),
    subscribe: () => () => {},
    load: async () => {},
    submit: async () => {
      fetcher.submitted++
    },
  }
  return fetcher
}

interface FakeRouter {
  readonly inner: ClientRouter
  publish(next: RouterState): void
  readonly navigations: string[]
  readonly submits: string[]
  readonly invalidations: (readonly string[] | undefined)[]
  /** Hold `navigate` until the returned function runs. */
  hold(): () => void
  readonly fetcher: ReturnType<typeof fetcherStub>
}

const fakeRouter = (initial: RouterState): FakeRouter => {
  let current = initial
  const listeners = new Set<() => void>()
  const navigations: string[] = []
  const submits: string[] = []
  const invalidations: (readonly string[] | undefined)[] = []
  let held: Promise<void> | undefined
  const fetcher = fetcherStub()
  const inner: ClientRouter = {
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    navigate: async (path) => {
      navigations.push(path)
      await held
    },
    submit: async (action) => {
      submits.push(action)
    },
    hydrate: async () => {},
    invalidate: async (paths) => {
      invalidations.push(paths)
    },
    prefetch: async () => {},
    fetcher: () => fetcher,
    fetchers: () => [fetcher],
    subscribeFetchers: () => () => {},
    match: (path) => ({ routeId: path, params: {} }),
  }
  return {
    inner,
    publish: (next) => {
      current = next
      for (const listener of [...listeners]) listener()
    },
    navigations,
    submits,
    invalidations,
    hold: () => {
      let release = (): void => {}
      held = new Promise((resolve) => {
        release = () => {
          held = undefined
          resolve()
        }
      })
      return release
    },
    fetcher,
  }
}

const chain = (...ids: string[]): MatchChain => ({ ids, handles: ids.map(() => undefined) })
const CHAINS: Record<string, MatchChain> = {
  list: chain("_layout", "list"),
  detail: chain("_layout", "detail"),
  item: chain("_layout", "shop/_layout", "item"),
}

interface Setup {
  readonly router: KeepAliveRouter
  readonly fake: FakeRouter
  readonly client: ReturnType<typeof keepAliveClient>
  readonly drops: [KeepAliveDropReason, readonly string[]][]
  /** A link to `next`: a fresh entry, the router's pending tick, then the settled page. */
  push(next: RouterState): void
  /** Back or forward by `delta` to a page whose reload settles with `next`. */
  traverse(delta: number, next: RouterState): Promise<void>
}

const setup = (
  initial: RouterState,
  options: {
    readonly hooks?: Record<string, ClientRouteHooks>
    readonly max?: number
    readonly fetchData?: KeepAliveClientOptions["fetchData"]
    readonly layouts?: readonly string[]
    readonly chains?: Record<string, MatchChain>
  } = {},
): Setup => {
  const fake = fakeRouter(initial)
  const drops: [KeepAliveDropReason, readonly string[]][] = []
  const hooks = options.hooks ?? { list: { keepAlive: true }, item: { keepAlive: true } }
  const clientOptions: {
    -readonly [K in keyof KeepAliveClientOptions]: KeepAliveClientOptions[K]
  } = {
    table: { routes: Object.keys(hooks), layouts: options.layouts ?? ["shop/_layout"] },
    routeHooks: hooks,
    matchChains: options.chains ?? CHAINS,
    onDrop: (reason, instances) => drops.push([reason, instances]),
  }
  if (options.max !== undefined) clientOptions.max = options.max
  if (options.fetchData !== undefined) clientOptions.fetchData = options.fetchData
  const client = keepAliveClient(clientOptions)
  const router = client.attach(fake.inner)
  return {
    router,
    fake,
    client,
    drops,
    push: (next) => {
      fakeHistory.push()
      fake.publish({ ...fake.inner.snapshot(), pending: true, pendingPath: next.path })
      fake.publish(next)
    },
    traverse: async (delta, next) => {
      fakeHistory.go(delta)
      const done = router.navigate(next.path)
      fake.publish({ ...fake.inner.snapshot(), pending: true, pendingPath: next.path })
      fake.publish(next)
      await done
    },
  }
}

const keptOf = (router: KeepAliveRouter): string[] =>
  (router.snapshot().kept ?? []).map((page) => page.state.path)

// ---- the router layer ----------------------------------------------------------------------------

describe("keepAliveClient", () => {
  test("a page left by a push is kept, and back to its own entry shows that same instance", async () => {
    const list = state("list", "/list/1", { params: { id: "1" } })
    const { router, push, fake, traverse } = setup(list)
    const first = router.snapshot().instance
    expect(first).toBeString()
    expect(fakeHistory.entries[0]?.nifraInstance).toBe(first)

    push(state("detail", "/detail"))
    expect(router.snapshot().kept).toEqual([{ instance: String(first), state: list }])
    expect(router.snapshot().instance).not.toBe(first)

    fakeHistory.go(-1)
    const restoring = router.navigate("/list/1")
    // On screen at once, before the router reloads it.
    expect(router.snapshot()).toMatchObject({
      instance: first,
      data: list.data,
      restored: true,
      revalidating: true,
    })
    expect(router.snapshot().kept).toBeUndefined()
    expect(fake.navigations).toEqual(["/list/1"])
    fake.publish({ ...fake.inner.snapshot(), pending: true, pendingPath: "/list/1" })
    expect(router.snapshot().restored).toBe(true)
    // The reload lands: the router's state, with the kept params' identity.
    const reloaded = state("list", "/list/1", { params: { id: "1" }, data: { fresh: true } })
    fake.publish(reloaded)
    await restoring
    expect(router.snapshot()).toMatchObject({ instance: first, data: { fresh: true } })
    expect(router.snapshot().restored).toBeUndefined()
    expect(router.snapshot().params).toBe(list.params)
    void traverse
  })

  test("a page left by a replace is discarded with its entry", () => {
    const { router, fake } = setup(state("list", "/list/1"))
    fakeHistory.replace()
    fake.publish(state("detail", "/detail"))
    expect(router.snapshot().kept).toBeUndefined()
  })

  test("only a settled page whose route exports keepAlive is kept", () => {
    const { router, push, fake } = setup(state("detail", "/detail"))
    push(state("detail", "/detail/2"))
    expect(router.snapshot().kept).toBeUndefined()
    push(state("list", "/list/1"))
    fakeHistory.push()
    fake.publish({ ...fake.inner.snapshot(), pending: true, pendingPath: "/detail" })
    expect(router.snapshot().kept).toBeUndefined()
  })

  test("a page left with a boundary open is kept with it, and back to that entry opens it again", async () => {
    const photo: BoundaryState = {
      name: "photo",
      mode: { intercept: "/photo/[id]" },
      status: "ready",
      data: { photo: 3 },
    }
    const modal = state("list", "/photo/3", {
      intercepted: { boundary: "photo", pagePath: "/list/1" },
      boundaries: { photo },
    })
    const { router, push, fake } = setup(state("list", "/list/1"))
    const first = router.snapshot().instance
    // Opening the boundary does not leave the page; leaving it then keeps both.
    push(modal)
    expect(router.snapshot().instance).toBe(first)
    expect(fakeHistory.entries[1]?.nifraInstance).toBe(first)
    push(state("detail", "/detail"))
    expect(router.snapshot().kept).toEqual([{ instance: String(first), state: modal }])

    const step = fake.hold()
    fakeHistory.go(-1)
    const restoring = router.navigate("/photo/3")
    expect(router.snapshot()).toMatchObject({ instance: first, path: "/photo/3", restored: true })
    expect(router.snapshot().intercepted).toEqual(modal.intercepted)
    // The router loads the page under the boundary first; on its own it is not what was left.
    expect(fake.navigations).toEqual(["/list/1"])
    fake.publish({ ...fake.inner.snapshot(), pending: true, pendingPath: "/list/1" })
    fake.publish(state("list", "/list/1", { data: { fresh: "page" } }))
    expect(router.snapshot()).toMatchObject({ path: "/photo/3", restored: true })
    step()
    // Then the target, which the router opens in the boundary over that page.
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.navigations).toEqual(["/list/1", "/photo/3"])
    fake.publish({ ...fake.inner.snapshot(), pending: true, pendingPath: "/photo/3" })
    expect(router.snapshot().restored).toBe(true)
    const reopened = { ...modal, data: { fresh: "page" } }
    fake.publish(reopened)
    await restoring
    expect(router.snapshot()).toMatchObject({ instance: first, data: { fresh: "page" } })
    expect(router.snapshot().intercepted).toEqual(modal.intercepted)
    expect(router.snapshot().restored).toBeUndefined()
  })

  test("a kept boundary's target reloads shared onto what it showed, or shows that unrequested", async () => {
    const photo: BoundaryState = {
      name: "photo",
      mode: { intercept: "/photo/[id]" },
      status: "ready",
      data: { tags: [1] },
    }
    const modal = state("list", "/photo/3", {
      data: { rows: [1] },
      intercepted: { boundary: "photo", pagePath: "/list/1" },
      boundaries: { photo },
    })
    const requests: string[] = []
    let respond = (path: string): unknown => ({ v: 1, data: { path } })
    const once = async (revalidate: boolean, check: (client: Setup["client"]) => Promise<void>) => {
      const { router, push, fake, client } = setup(state("list", "/list/1"), {
        hooks: { list: { keepAlive: { revalidate } } },
        fetchData: async (path) => {
          requests.push(path)
          return respond(path)
        },
      })
      push(modal)
      push(state("detail", "/detail"))
      const release = fake.hold()
      fakeHistory.go(-1)
      const restoring = router.navigate("/photo/3")
      await check(client)
      release()
      await restoring
    }
    const match: RouteMatch = { routeId: "photo", params: {} }

    await once(false, async (client) => {
      expect(await client.fetchData("/list/1", match)).toMatchObject({ v: 1, data: modal.data })
      expect(await client.fetchData("/photo/3", match)).toEqual({
        v: 1,
        data: photo.data,
        live: undefined,
      })
      expect(requests).toEqual([])
    })
    await once(true, async (client) => {
      respond = () => ({ v: 1, data: { tags: [1] } })
      expect(at(await client.fetchData("/photo/3", match), "data")).toBe(photo.data)
      respond = () => ({ tags: [1] })
      expect(await client.fetchData("/photo/3", match)).toBe(photo.data)
      respond = () => ({ v: 1, data: null, status: 404 })
      expect(await client.fetchData("/photo/3", match)).toEqual({ v: 1, data: null, status: 404 })
      respond = () => {
        throw new Error("offline")
      }
      expect(await client.fetchData("/photo/3", match)).toEqual({
        v: 1,
        data: photo.data,
        live: undefined,
      })
    })
    expect(requests).toEqual(["/photo/3", "/photo/3", "/photo/3", "/photo/3"])
  })

  test("a modal restore that the router does not answer on the page ends there", async () => {
    const modal = state("list", "/photo/3", {
      intercepted: { boundary: "photo", pagePath: "/list/1" },
    })
    const { router, push, fake } = setup(state("list", "/list/1"))
    push(modal)
    push(state("detail", "/detail"))
    fakeHistory.go(-1)
    // The page's reload settles without a publish: the router is still on the page being left.
    await router.navigate("/photo/3")
    expect(fake.navigations).toEqual(["/list/1"])
    push(state("detail", "/detail/2"))
    expect(router.snapshot().restored).toBeUndefined()
  })

  test("a link to a kept page's path renders a fresh page", async () => {
    const { router, push, fake } = setup(state("list", "/list/1"))
    const first = router.snapshot().instance
    push(state("detail", "/detail"))
    fakeHistory.push()
    await router.navigate("/list/1")
    expect(fake.navigations).toEqual(["/list/1"])
    fake.publish(state("list", "/list/1"))
    expect(router.snapshot().instance).not.toBe(first)
    expect(keptOf(router)).toEqual(["/list/1"])
  })

  test("a new pathname of a keepAlive route is a new instance; a new query string is not", () => {
    const { router, fake, push } = setup(state("list", "/list/1"))
    const first = router.snapshot().instance
    fakeHistory.replace()
    fake.publish(state("list", "/list/1?sort=name"))
    expect(router.snapshot().instance).toBe(first)
    push(state("list", "/list/2"))
    expect(router.snapshot().instance).not.toBe(first)
    expect(keptOf(router)).toEqual(["/list/1?sort=name"])
  })

  test("a push after going back cuts the pages ahead of it", async () => {
    const { router, push, traverse, drops } = setup(state("list", "/list/1"))
    push(state("list", "/list/2"))
    push(state("list", "/list/3"))
    await traverse(-1, state("list", "/list/2"))
    await traverse(-1, state("list", "/list/1"))
    expect(keptOf(router)).toEqual(["/list/3", "/list/2"])
    push(state("detail", "/detail"))
    expect(drops.map(([reason, gone]) => [reason, gone.length])).toEqual([["forward", 2]])
    expect(keptOf(router)).toEqual(["/list/1"])
  })

  test("past the cap the page shown longest ago goes first", () => {
    const { router, push, drops } = setup(state("list", "/list/1"), { max: 2 })
    push(state("list", "/list/2"))
    push(state("list", "/list/3"))
    push(state("detail", "/detail"))
    expect(keptOf(router)).toEqual(["/list/2", "/list/3"])
    expect(drops.map(([reason]) => reason)).toEqual(["lru"])
  })

  test("a page hidden longer than its maxAge is dropped, and back renders it fresh", async () => {
    let at = 1_000
    const clock = spyOn(Date, "now").mockImplementation(() => at)
    try {
      const { router, push, fake, drops } = setup(state("list", "/list/1"), {
        hooks: { list: { keepAlive: { maxAge: 500 } } },
      })
      push(state("detail", "/detail"))
      at += 501
      fakeHistory.go(-1)
      await router.navigate("/list/1")
      expect(drops).toEqual([["expired", [expect.any(String)]]])
      expect(router.snapshot().restored).toBeUndefined()
      expect(fake.navigations).toEqual(["/list/1"])
    } finally {
      clock.mockRestore()
    }
  })

  test("revalidate: false shows the kept data without a request, until a submit marks it stale", async () => {
    const requests: string[] = []
    const kept = state("list", "/list/1", { layoutData: [{ nav: 1 }] })
    const { router, push, fake, client } = setup(kept, {
      hooks: { list: { keepAlive: { revalidate: false } } },
      fetchData: async (path) => {
        requests.push(path)
        return { v: 1, data: { path } }
      },
    })
    const match: RouteMatch = { routeId: "list", params: {} }
    push(state("detail", "/detail"))
    const release = fake.hold()
    fakeHistory.go(-1)
    const restoring = router.navigate("/list/1")
    expect(router.snapshot().revalidating).toBe(false)
    expect(await client.fetchData("/list/1", match)).toEqual({
      v: 1,
      data: kept.data,
      layoutData: kept.layoutData,
      serverComponents: undefined,
      live: undefined,
    })
    expect(requests).toEqual([])
    release()
    await restoring

    // A submit while the page is hidden marks it stale: it reloads when shown.
    push(state("detail", "/detail"))
    await router.submit("/detail", "x=1")
    expect(fake.submits).toEqual(["/detail"])
    fakeHistory.go(-1)
    void router.navigate("/list/1")
    expect(router.snapshot().revalidating).toBe(true)
    await client.fetchData("/list/1", match)
    expect(requests).toEqual(["/list/1"])
  })

  test("a restore's reload is shared onto the kept data, and falls back to it on failure", async () => {
    const kept = state("list", "/list/1", {
      data: { rows: [{ id: 1 }], title: "a" },
      layoutData: [{ nav: [1] }, { side: [2] }],
      boundaries: { modal: { name: "modal", mode: "static", status: "ready", data: { x: 1 } } },
    })
    let respond: () => unknown = () => ({})
    const { router, push, fake, client } = setup(kept, {
      fetchData: async () => respond(),
    })
    const match: RouteMatch = { routeId: "list", params: {} }
    push(state("detail", "/detail"))
    const release = fake.hold()
    fakeHistory.go(-1)
    const restoring = router.navigate("/list/1")

    respond = () => ({
      v: 1,
      data: { rows: [{ id: 1 }], title: "b" },
      layoutData: [{ nav: [1] }, { side: [3] }],
      retained: [1],
      boundaries: { modal: { name: "modal", mode: "static", status: "ready", data: { x: 1 } } },
    })
    const shared = await client.fetchData("/list/1", match)
    expect(at(shared, "data", "rows")).toBe(at(kept.data, "rows"))
    expect(at(shared, "data", "title")).toBe("b")
    expect(at(shared, "layoutData", "0")).toBe(kept.layoutData?.[0])
    // A retained layout keeps the value the server skipped sending, untouched.
    expect(at(shared, "layoutData", "1")).toEqual({ side: [3] })
    expect(at(shared, "boundaries")).toBe(kept.boundaries)

    respond = () => ({ v: 1, data: null, status: 404 })
    expect(await client.fetchData("/list/1", match)).toEqual({ v: 1, data: null, status: 404 })
    respond = () => ({ rows: [{ id: 1 }], title: "a" })
    expect(await client.fetchData("/list/1", match)).toBe(kept.data)

    respond = () => {
      throw new Error("offline")
    }
    expect(await client.fetchData("/list/1", match)).toMatchObject({ v: 1, data: kept.data })
    const redirect = Object.assign(new Error("moved"), { redirectTo: "/login" })
    respond = () => {
      throw redirect
    }
    await expect(client.fetchData("/list/1", match)).rejects.toBe(redirect)
    const aborted = new AbortController()
    aborted.abort()
    respond = () => {
      throw new Error("aborted")
    }
    await expect(client.fetchData("/list/1", match, aborted.signal)).rejects.toThrow("aborted")
    // Another path goes straight to the transport.
    respond = () => "other"
    expect(await client.fetchData("/detail", match)).toBe("other")
    release()
    await restoring
  })

  test("a route that opts out of sharing gets the response as sent", async () => {
    const kept = state("list", "/list/1", { data: { rows: [1] } })
    const { router, push, fake, client } = setup(kept, {
      hooks: { list: { keepAlive: true, shareData: false } },
      fetchData: async () => ({ v: 1, data: { rows: [1] } }),
    })
    push(state("detail", "/detail"))
    const release = fake.hold()
    fakeHistory.go(-1)
    const restoring = router.navigate("/list/1")
    const payload = await client.fetchData("/list/1", { routeId: "list", params: {} })
    expect(at(payload, "data")).not.toBe(kept.data)
    release()
    await restoring
  })

  test("a restore to a path whose query changed reloads even with revalidate: false", async () => {
    const { router, push, fake } = setup(state("list", "/list/1"), {
      hooks: { list: { keepAlive: { revalidate: false } } },
    })
    push(state("detail", "/detail"))
    const release = fake.hold()
    fakeHistory.go(-1)
    const restoring = router.navigate("/list/1?page=2")
    expect(router.snapshot().revalidating).toBe(true)
    release()
    await restoring
  })

  test("a restore that the router answers with a redirect hands the page to the router", async () => {
    const { router, push, fake } = setup(state("list", "/list/1"))
    push(state("detail", "/detail"))
    const release = fake.hold()
    fakeHistory.go(-1)
    const restoring = router.navigate("/list/1")
    fake.publish({ ...fake.inner.snapshot(), pending: true, pendingPath: "/login" })
    expect(router.snapshot().restored).toBeUndefined()
    fake.publish(state("detail", "/login"))
    expect(router.snapshot().path).toBe("/login")
    release()
    await restoring
  })

  test("a restore that settles without a publish ends with its navigation", async () => {
    const { router, push } = setup(state("list", "/list/1"))
    push(state("detail", "/detail"))
    fakeHistory.go(-1)
    await router.navigate("/list/1")
    // The next navigation is the router's again.
    push(state("detail", "/detail"))
    expect(router.snapshot().restored).toBeUndefined()
  })

  test("a submit or an invalidation waits for a restore in flight, and marks kept pages stale", async () => {
    const { router, push, fake } = setup(state("list", "/list/1"))
    push(state("list", "/list/2"))
    push(state("detail", "/detail"))
    const release = fake.hold()
    fakeHistory.go(-1)
    const restoring = router.navigate("/list/2")
    let submitted = false
    const submit = router.submit("/list/2", "x=1").then(() => {
      submitted = true
    })
    const invalidated = router.invalidate(["/list/1"])
    await Promise.resolve()
    expect(submitted).toBe(false)
    expect(fake.submits).toEqual([])
    fake.publish(state("list", "/list/2"))
    release()
    await Promise.all([restoring, submit, invalidated])
    expect(fake.submits).toEqual(["/list/2"])
    expect(fake.invalidations).toEqual([["/list/1"]])
  })

  test("a fetcher's submit marks kept pages stale; the rest passes through", async () => {
    const { router, fake } = setup(state("list", "/list/1"))
    const fetcher = router.fetcher("f")
    expect(router.fetcher("f")).toBe(fetcher)
    await fetcher.submit("/x", "a=1")
    expect(fake.fetcher.submitted).toBe(1)
    expect(fetcher.snapshot).toBe(fake.fetcher.snapshot)
    expect(router.fetchers()).toEqual([fake.fetcher])
    expect(router.match("/a")).toEqual({ routeId: "/a", params: {} })
    expect(router.subscribeFetchers(() => {})).toBeFunction()
    await router.hydrate()
    await router.prefetch("/a")
  })

  test("while a loading view shows, the page being left stays mounted with no instance on screen", () => {
    const { router, fake } = setup(state("list", "/list/1"))
    const first = router.snapshot().instance
    fakeHistory.push()
    fake.publish(state("detail", "/detail", { pending: true, pendingPath: "/detail" }))
    expect(router.snapshot().instance).toBeUndefined()
    expect(router.snapshot().kept?.map((page) => page.instance)).toEqual([String(first)])
    fake.publish(state("detail", "/detail"))
    expect(router.snapshot().kept?.map((page) => page.instance)).toEqual([String(first)])
    expect(router.snapshot().instance).toBeString()
  })

  test("dropKept mid-navigation leaves the page being left unkept", () => {
    const { router, fake, drops } = setup(state("list", "/list/1"))
    fakeHistory.push()
    fake.publish(state("detail", "/detail", { pending: true, pendingPath: "/detail" }))
    router.dropKept()
    fake.publish(state("detail", "/detail"))
    expect(router.snapshot().kept).toBeUndefined()
    expect(drops).toEqual([])
    // With nothing kept and no navigation running, it is a no-op.
    router.dropKept("manual")
  })

  test("a kept page that would leave the page on screen inside an unwrapped layout is dropped", () => {
    const { router, push, drops } = setup(state("item", "/shop/a"), { layouts: [] })
    push(state("detail", "/detail"))
    expect(router.snapshot().kept).toBeUndefined()
    expect(drops.map(([reason]) => reason)).toEqual(["layout"])
  })

  test("a page being left that cannot be placed is not kept when its navigation settles", () => {
    const { router, fake } = setup(state("item", "/shop/a"), { layouts: [] })
    fakeHistory.push()
    fake.publish(state("detail", "/detail", { pending: true, pendingPath: "/detail" }))
    fake.publish(state("detail", "/detail"))
    expect(router.snapshot().kept).toBeUndefined()
  })

  test("beforePublish sees each state first; dropKept publishes the drop", () => {
    const { router, push, drops } = setup(state("list", "/list/1"))
    const seen: (string | undefined)[] = []
    const stop = router.beforePublish((next) => seen.push(next.path))
    let published = 0
    const unsubscribe = router.subscribe(() => published++)
    push(state("detail", "/detail"))
    router.dropKept()
    expect(drops.map(([reason]) => reason)).toEqual(["manual"])
    expect(router.snapshot().kept).toBeUndefined()
    stop()
    unsubscribe()
    push(state("list", "/list/2"))
    // The router's pending tick, the settled page, then the drop.
    expect(seen).toEqual(["/list/1", "/detail", "/detail"])
    expect(published).toBe(3)
  })

  test("a new epoch cookie after a navigation drops every kept page and tells the other tabs", () => {
    fakeDocument.cookie = "theme=dark; nifra-epoch=a"
    const { router, push, drops } = setup(state("list", "/list/1"))
    push(state("list", "/list/2"))
    fakeDocument.cookie = "theme=dark; nifra-epoch=b"
    push(state("detail", "/detail"))
    expect(router.snapshot().kept).toBeUndefined()
    expect(drops.map(([reason]) => reason)).toEqual(["identity"])
    expect(FakeChannel.open[0]?.sent).toEqual(["changed"])
  })

  test("a restore whose page was kept under another epoch renders fresh", async () => {
    fakeDocument.cookie = "__Host-nifra-epoch=a"
    const { router, push, fake, drops } = setup(state("list", "/list/1"))
    push(state("detail", "/detail"))
    fakeDocument.cookie = "__Host-nifra-epoch=b; nifra-epoch=a"
    fakeHistory.go(-1)
    await router.navigate("/list/1")
    expect(drops.map(([reason]) => reason)).toEqual(["identity"])
    expect(router.snapshot().restored).toBeUndefined()
    expect(fake.navigations).toEqual(["/list/1"])
  })

  test("another tab's sign-out, identityChanged() and a visible tab's new epoch each drop", () => {
    const { router, push, drops } = setup(state("list", "/list/1"))
    const other = new FakeChannel("nifra-identity-v1")
    push(state("detail", "/detail"))
    other.postMessage("changed")
    expect(drops.map(([reason]) => reason)).toEqual(["identity"])

    push(state("list", "/list/2"))
    push(state("detail", "/detail"))
    identityChanged()
    expect(drops.map(([reason]) => reason)).toEqual(["identity", "identity"])

    push(state("list", "/list/3"))
    push(state("detail", "/detail"))
    fakeDocument.cookie = "nifra-epoch=c"
    dispatchEvent(new Event("visibilitychange"))
    expect(drops.map(([reason]) => reason)).toEqual(["identity", "identity", "identity"])
    expect(router.snapshot().kept).toBeUndefined()
  })

  test("a document entering the back/forward cache drops its kept pages first", () => {
    const { push, drops } = setup(state("list", "/list/1"))
    push(state("detail", "/detail"))
    dispatchEvent(new Event("pagehide"))
    expect(drops).toEqual([])
    const cached = new Event("pagehide")
    Object.defineProperty(cached, "persisted", { value: true })
    dispatchEvent(cached)
    expect(drops.map(([reason]) => reason)).toEqual(["pagehide"])
  })

  test("back to a page that was dropped renders it fresh under its entry's instance", async () => {
    const { router, push, fake } = setup(state("list", "/list/1"))
    const first = router.snapshot().instance
    push(state("detail", "/detail"))
    router.dropKept()
    fakeHistory.go(-1)
    await router.navigate("/list/1")
    expect(fake.navigations).toEqual(["/list/1"])
    fake.publish(state("list", "/list/1"))
    expect(router.snapshot()).toMatchObject({ instance: first, path: "/list/1" })
    expect(router.snapshot().restored).toBeUndefined()
  })

  test("a listener removed from identity changes hears none", () => {
    let heard = 0
    const off = onIdentityChange(() => heard++)
    identityChanged()
    off()
    identityChanged()
    expect(heard).toBe(1)
  })

  test("an entry from an earlier document carries no instance this one knows", () => {
    fakeHistory.entries[0] = { nifraIndex: 0, nifraInstance: "4:elsewhere" }
    const { router } = setup(state("list", "/list/1"))
    expect(router.snapshot().instance).not.toBe("4:elsewhere")
  })
})

// ---- the view tree -------------------------------------------------------------------------------

describe("keepAliveClient over the client router", () => {
  const photoBoundary = { name: "photo", mode: { intercept: "/photos/:id" } } as const
  const unresolved = { photo: { ...photoBoundary, status: "unresolved" } } as const
  // Answers each data request with what was asked for and how often; the page as the envelope a
  // server sends, its intercept boundary unresolved.
  const served = () => {
    const calls: string[] = []
    const fetchData: FetchRouteData = async (path, match) => {
      calls.push(path)
      const n = calls.filter((call) => call === path).length
      return match.routeId === "index"
        ? { v: 1, data: { from: path, n }, boundaries: unresolved }
        : { from: path, n }
    }
    return { calls, fetchData }
  }

  test("back to a page left with its boundary open shows both again, then reloads both", async () => {
    const server = served()
    const routeHooks: Record<string, ClientRouteHooks> = {
      index: { keepAlive: true, boundaries: [photoBoundary] },
    }
    const keep = keepAliveClient({
      table: { routes: ["index"], layouts: [] },
      routeHooks,
      matchChains: { index: chain("index"), photo: chain("photo"), about: chain("about") },
      fetchData: server.fetchData,
    })
    const router = keep.attach(
      createClientRouter({
        patterns: [
          { routeId: "index", pattern: "/" },
          { routeId: "photo", pattern: "/photos/:id" },
          { routeId: "about", pattern: "/about" },
        ],
        initial: {
          routeId: "index",
          params: {},
          path: "/",
          data: { from: "/", n: 0 },
          boundaries: unresolved,
          pending: false,
        },
        fetchData: keep.fetchData,
        routeHooks,
      }),
    )
    const first = router.snapshot().instance
    fakeHistory.push()
    await router.navigate("/photos/1")
    const open = router.snapshot()
    expect(open).toMatchObject({ path: "/photos/1", instance: first })
    expect(open.intercepted).toEqual({ boundary: "photo", pagePath: "/" })
    fakeHistory.push()
    await router.navigate("/about")
    expect(router.snapshot().routeId).toBe("about")
    expect(router.snapshot().kept?.map((page) => [page.instance, page.state.path])).toEqual([
      [String(first), "/photos/1"],
    ])

    fakeHistory.go(-1)
    const restoring = router.navigate("/photos/1")
    expect(router.snapshot()).toMatchObject({ path: "/photos/1", instance: first, restored: true })
    expect(router.snapshot().boundaries?.photo?.data).toEqual({ from: "/photos/1", n: 1 })
    await restoring
    const back = router.snapshot()
    expect(back).toMatchObject({ routeId: "index", path: "/photos/1", instance: first })
    expect(back.intercepted).toEqual({ boundary: "photo", pagePath: "/" })
    expect(back.restored).toBeUndefined()
    expect(back.data).toEqual({ from: "/", n: 1 })
    expect(back.boundaries?.photo).toMatchObject({
      status: "ready",
      data: { from: "/photos/1", n: 2 },
    })
    expect(server.calls).toEqual(["/photos/1", "/about", "/", "/photos/1"])
  })
})

describe("slotTree", () => {
  const table = { routes: ["list", "item"], layouts: ["shop/_layout"] }
  const kept = (instance: string, routeId: string, path: string) => ({
    instance,
    state: state(routeId, path),
  })

  test("one page: its layouts, then the page in its wrappers", () => {
    const tree = slotTree({ ...state("list", "/list/1"), instance: "1:d" }, CHAINS, table)
    expect(tree).toEqual([
      {
        key: "_layout",
        depth: 0,
        state: expect.any(Object),
        hidden: false,
        wrapped: false,
        children: [
          { key: "\u00001:d", depth: 1, state: expect.any(Object), hidden: false, wrapped: true },
        ],
      },
    ])
  })

  test("kept pages sit beside the page on screen in the order they were made", () => {
    const active = {
      ...state("detail", "/detail"),
      instance: "3:d",
      kept: [kept("2:d", "item", "/shop/b"), kept("1:d", "list", "/list/1")],
    }
    const [root] = slotTree(active, CHAINS, table)
    expect(root?.state).toBe(active)
    expect(root?.children?.map((node) => [node.key, node.hidden, node.wrapped])).toEqual([
      ["\u00001:d", true, true],
      ["shop/_layout", true, true],
      ["\u00003:d", false, false],
    ])
  })

  test("a layout only kept pages share renders from the one shown most recently", () => {
    const active = {
      ...state("detail", "/detail"),
      instance: "3:d",
      kept: [kept("1:d", "item", "/shop/a"), kept("2:d", "item", "/shop/b")],
    }
    const shop = slotTree(active, CHAINS, table)[0]?.children?.[0]
    expect(shop?.state.path).toBe("/shop/b")
    expect(shop?.children?.map((node) => node.key)).toEqual(["\u00001:d", "\u00002:d"])
  })

  test("an unchanged node keeps its identity; a changed one is new", () => {
    const active = {
      ...state("list", "/list/1"),
      instance: "2:d",
      kept: [kept("1:d", "item", "/a")],
    }
    const first = slotTree(active, CHAINS, table)
    const again = slotTree(active, CHAINS, table, first)
    expect(again[0]).toBe(first[0])
    const moved = slotTree({ ...active, instance: "3:d" }, CHAINS, table, first)
    expect(moved[0]).not.toBe(first[0])
    expect(moved[0]?.children?.[0]).toBe(first[0]?.children?.[0])
  })

  test("the loading view has its own key, and a route without a chain is its own leaf", () => {
    const tree = slotTree(state("unknown", "/x"), {}, table)
    expect(tree.map((node) => [node.key, node.wrapped])).toEqual([["\u0000loading", false]])
  })
})

describe("keepAliveTable", () => {
  const load = () => async (): Promise<RouteModule> => ({ default: () => null })

  test("no keepAlive route, no table", () => {
    expect(keepAliveTable(buildManifest(["index.tsx"], load))).toBeUndefined()
  })

  test("a layout is wrapped where another chain shares what is above it and not it", () => {
    const manifest = buildManifest(
      [
        "_layout.tsx",
        "index.tsx",
        "_404.tsx",
        "shop/_layout.tsx",
        "shop/[item].tsx",
        "shop/_loading.tsx",
        "shop/deals/_layout.tsx",
        "shop/deals/index.tsx",
      ],
      load,
      { keepAlive: ["shop/[item].tsx", "shop/deals/index.tsx"] },
    )
    const table = keepAliveTable(manifest)
    expect(table?.routes).toEqual(["shop/[item]", "shop/deals/index"])
    expect(table?.layouts).toEqual(["shop/_layout", "shop/deals/_layout"])
    expect(
      slotDepths(table ?? { routes: [], layouts: [] }, ["_layout", "shop/_layout"], "shop/[item]"),
    ).toEqual([1, 2])
    expect(slotDepths(table ?? { routes: [], layouts: [] }, ["_layout"], undefined)).toEqual([])
  })
})

// ---- the DOM half --------------------------------------------------------------------------------

class FakeElement {
  children: FakeElement[] = []
  parent: FakeElement | null = null
  scrollTop = 0
  scrollLeft = 0
  readonly events: string[] = []
  focused = 0
  constructor(
    readonly tagName: string,
    readonly id = "",
    readonly classes: readonly string[] = [],
  ) {}
  get parentElement(): FakeElement | null {
    return this.parent
  }
  get parentNode(): FakeElement | null {
    return this.parent
  }
  get nextSibling(): FakeElement | null {
    if (this.parent === null) return null
    return this.parent.children[this.parent.children.indexOf(this) + 1] ?? null
  }
  get isConnected(): boolean {
    let node: FakeElement | null = this
    while (node.parent !== null) node = node.parent
    return node.tagName === "HTML"
  }
  append(...nodes: FakeElement[]): this {
    for (const node of nodes) this.insertBefore(node, null)
    return this
  }
  insertBefore(node: FakeElement, before: FakeElement | null): void {
    node.remove()
    node.parent = this
    const at = before === null ? -1 : this.children.indexOf(before)
    if (at === -1) this.children.push(node)
    else this.children.splice(at, 0, node)
  }
  remove(): void {
    if (this.parent === null) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  contains(node: unknown): boolean {
    for (let at = node instanceof FakeElement ? node : null; at !== null; at = at.parent)
      if (at === this) return true
    return false
  }
  querySelectorAll(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll()])
  }
  dispatchEvent(event: Event): boolean {
    this.events.push(event.type)
    return true
  }
  focus(): void {
    this.focused++
  }
  // Tags, `#id`, `.class` and `*` compounds, with pseudo-classes ignored, are all a test needs.
  matches(selector: string): boolean {
    if (selector.includes("!")) throw new SyntaxError(selector)
    const bare = selector.replace(/:[a-z-]+(\([^)]*\))?/g, "")
    if (bare === "" || bare === "*") return true
    return (bare.match(/[#.]?[\w-]+|\*/g) ?? []).every((part) =>
      part.startsWith("#")
        ? this.id === part.slice(1)
        : part.startsWith(".")
          ? this.classes.includes(part.slice(1))
          : part === "*" || part.toUpperCase() === this.tagName,
    )
  }
  closest(selector: string): FakeElement | null {
    for (let at: FakeElement | null = this; at !== null; at = at.parent)
      if (at.matches(selector)) return at
    return null
  }
}

// biome-ignore lint/plugin/noChainedTypeAssertions: a FakeElement is not an Element, only a stand-in for one
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: it implements every member slot parking and the CSS check read or call
const asElement = (element: FakeElement): Element => element as unknown as Element

describe("createSlotParking", () => {
  const node = (key: string, hidden: boolean): SlotNode => ({
    key,
    depth: 1,
    state: state("list", "/list"),
    hidden,
    wrapped: true,
  })

  test("parks a hidden slot and puts it back with its scroll offsets and focus", () => {
    const html = new FakeElement("HTML")
    const main = new FakeElement("MAIN")
    const entry = new FakeElement("DIV")
    const page = new FakeElement("DIV")
    const inner = new FakeElement("DIV")
    const input = new FakeElement("INPUT")
    html.append(main.append(entry.append(page.append(inner.append(input)))))
    const parking = createSlotParking()
    expect(parking.entry("k")).toBe(parking.entry("k"))
    parking.entry("k")(asElement(entry))
    parking.page("k")(asElement(page))
    parking.after([node("k", false)])

    inner.scrollTop = 40
    page.scrollLeft = 5
    fakeDocument.activeElement = input
    parking.before([node("k", true)])
    // Before the router publishes what hides it, while the page is still in the document.
    expect([page.events, entry.children]).toEqual([[PAGE_HIDE_EVENT], [page]])
    // React detaches refs inside a hidden Activity: the page stays known.
    parking.page("k")(null)
    parking.after([node("k", true)])
    expect(entry.children).toEqual([])
    expect(page.events).toEqual([PAGE_HIDE_EVENT])
    parking.after([node("k", true)])
    expect(page.events).toEqual([PAGE_HIDE_EVENT])

    inner.scrollTop = 0
    page.scrollLeft = 0
    parking.before([node("k", false)])
    expect(entry.children).toEqual([page])
    parking.after([node("k", false)])
    expect([inner.scrollTop, page.scrollLeft, input.focused]).toEqual([40, 5, 1])
    expect(page.events).toEqual([PAGE_HIDE_EVENT, PAGE_SHOW_EVENT])
  })

  test("a slot shown again before it was parked is told so before the render", () => {
    const entry = new FakeElement("DIV")
    const page = new FakeElement("DIV")
    new FakeElement("HTML").append(entry.append(page))
    const parking = createSlotParking()
    parking.entry("k")(asElement(entry))
    parking.page("k")(asElement(page))
    parking.after([node("k", false)])
    parking.before([node("k", true)])
    parking.before([node("k", true)])
    parking.before([node("k", false)])
    expect(page.events).toEqual([PAGE_HIDE_EVENT, PAGE_SHOW_EVENT])
    parking.after([node("k", false)])
    expect([page.events, entry.children]).toEqual([[PAGE_HIDE_EVENT, PAGE_SHOW_EVENT], [page]])
  })

  test("a slot hidden in the same render that hides it remembers its offsets then", () => {
    const html = new FakeElement("HTML")
    const entry = new FakeElement("DIV")
    const page = new FakeElement("DIV")
    const scroller = new FakeElement("DIV")
    html.append(entry.append(page.append(scroller)))
    const parking = createSlotParking()
    parking.entry("k")(asElement(entry))
    parking.page("k")(asElement(page))
    parking.after([node("k", false)])
    scroller.scrollTop = 7
    parking.after([node("k", true)])
    scroller.scrollTop = 0
    parking.after([node("k", false)])
    expect(scroller.scrollTop).toBe(7)
  })

  test("a slot that leaves the tree is forgotten; one without elements is skipped", () => {
    const parking = createSlotParking()
    const ref = parking.entry("k")
    ref(asElement(new FakeElement("DIV")))
    parking.after([node("k", false), node("missing", true)])
    parking.after([])
    expect(parking.entry("k")).not.toBe(ref)
    parking.before([node("unknown", false)])
  })
})

describe("checkSlotCss", () => {
  class FakeStyleRule {
    constructor(readonly selectorText: string) {}
  }
  const savedRule = Reflect.get(globalThis, "CSSStyleRule")
  beforeEach(() => {
    Reflect.set(globalThis, "CSSStyleRule", FakeStyleRule)
  })
  afterEach(() => {
    Reflect.set(globalThis, "CSSStyleRule", savedRule)
  })

  const layout = () => {
    const main = new FakeElement("MAIN", "main")
    const entry = new FakeElement("DIV")
    const page = new FakeElement("DIV")
    const section = new FakeElement("SECTION", "", ["list-page"])
    main.append(entry.append(page.append(section)))
    return { main, entry, page }
  }
  const sheets = (...lists: unknown[][]) =>
    lists.map((rules, i) => ({ href: i === 0 ? null : `/s${i}.css`, cssRules: rules }))

  test("reports each selector the wrappers stop matching, once", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const { entry, page } = layout()
      fakeDocument.styleSheets = [
        ...sheets(
          [
            new FakeStyleRule("#main > .list-page, main section"),
            new FakeStyleRule(".list-page:first-child"),
            { cssRules: [new FakeStyleRule("main:has(> section)")] },
            new FakeStyleRule("[data-x='a,b'] > p"),
            new FakeStyleRule("main > !bad"),
          ],
          [new FakeStyleRule("main > .list-page")],
        ),
        {
          href: "https://cdn.test/x.css",
          get cssRules(): never {
            throw new Error("cross-origin")
          },
        },
      ]
      checkSlotCss(asElement(entry), asElement(page))
      checkSlotCss(asElement(entry), asElement(page))
      const reported = warn.mock.calls.map((call) => String(call[0]))
      expect(reported).toHaveLength(4)
      expect(
        reported.every((line) => line.startsWith("[nifra/web] NIFRA_KEEPALIVE_DIRECT_CHILD_CSS:")),
      ).toBe(true)
      expect(reported[0]).toContain('"#main > .list-page"')
      expect(reported[0]).toContain("direct child of <main>")
      expect(reported[1]).toContain('".list-page:first-child"')
      expect(reported[2]).toContain('"main:has(> section)"')
      expect(reported[3]).toContain('"main > .list-page" (/s1.css)')
    } finally {
      warn.mockRestore()
    }
  })

  test("a slot outside the document or with nothing in it is not checked", () => {
    const entry = new FakeElement("DIV")
    checkSlotCss(asElement(entry), asElement(new FakeElement("DIV")))
    const { entry: placed } = layout()
    checkSlotCss(asElement(placed), asElement(new FakeElement("DIV")))
  })
})
