/**
 * An intercept boundary holding a navigation's target over the page: the page and the target each
 * reload, cache and retain under their own path, never the other's.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  type BoundaryStates,
  createClientRouter,
  type FetchRouteData,
  type RouterState,
} from "../src/index.ts"
import { redirectOf } from "../src/router.ts"

const patterns = [
  { routeId: "index", pattern: "/" },
  { routeId: "photo", pattern: "/photos/:id" },
  { routeId: "about", pattern: "/about" },
  { routeId: "user", pattern: "/users/:id" },
]

const unresolved = (name: string, intercept: string) => ({
  name,
  mode: { intercept },
  status: "unresolved" as const,
})

const pageBoundaries: BoundaryStates = {
  photo: unresolved("photo", "/photos/:id"),
  user: unresolved("user", "/users/:id"),
}

const initial: RouterState = {
  routeId: "index",
  params: {},
  path: "/",
  data: { from: "/", n: 0 },
  layoutData: [{ layout: "root" }],
  boundaries: pageBoundaries,
  pending: false,
}

const hooks = {
  index: {
    boundaries: [
      { name: "photo", mode: { intercept: "/photos/:id" } },
      { name: "user", mode: { intercept: "/users/:id" } },
    ],
  },
}

type Call = { readonly path: string; readonly routeId: string; readonly from?: string }

// Answers each data request with what was asked for, counting per path, the page as the envelope a
// server sends (its intercept boundaries unresolved) and anything listed in `status` as a terminal.
function server(status: Record<string, number> = {}, fail: ReadonlySet<string> = new Set()) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const fetchData: FetchRouteData = async (path, match, _signal, navigation) => {
    const call = { path, routeId: match.routeId }
    calls.push(navigation === undefined ? call : { ...call, from: navigation.from })
    if (fail.has(path)) throw new Error(`[test] ${path} failed`)
    const n = (counts.get(path) ?? 0) + 1
    counts.set(path, n)
    if (status[path] !== undefined) return { v: 1, data: null, status: status[path] }
    return match.routeId === "index"
      ? {
          v: 1,
          data: { from: path, n },
          layoutData: [{ layout: "root" }],
          boundaries: pageBoundaries,
        }
      : { from: path, n }
  }
  return { calls, fetchData }
}

function actionAnswers(headers: Record<string, string> = {}) {
  const posted: string[] = []
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request) => {
        posted.push(String(input))
        return Response.json({ ok: true }, { headers })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  return { posted, spy }
}

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

async function opened(fetchData: FetchRouteData) {
  const router = createClientRouter({
    patterns,
    initial,
    fetchData,
    routeHooks: hooks,
    statusRoutes: { 404: "404" },
  })
  await router.navigate("/photos/2")
  return router
}

describe("an open intercept boundary", () => {
  test("names the boundary and the page underneath, and keeps the page's identity and data", async () => {
    const { fetchData } = server()
    const router = await opened(fetchData)
    expect(router.snapshot()).toMatchObject({
      routeId: "index",
      path: "/photos/2",
      data: { from: "/", n: 0 },
      intercepted: { boundary: "photo", pagePath: "/" },
      boundaries: { photo: { status: "ready", data: { from: "/photos/2", n: 1 } } },
    })
  })

  test("an action reloads the page under its own path and the target under its URL", async () => {
    const { calls, fetchData } = server()
    const router = await opened(fetchData)
    const { posted, spy } = actionAnswers()
    restore = () => spy.mockRestore()
    calls.length = 0
    await router.submit("/", new FormData())
    expect(posted).toEqual(["/"])
    expect(calls.map((call) => `${call.routeId} ${call.path}`).sort()).toEqual([
      "index /",
      "photo /photos/2",
    ])
    const state = router.snapshot()
    expect(state.routeId).toBe("index")
    expect(state.path).toBe("/photos/2")
    expect(state.data).toEqual({ from: "/", n: 1 })
    expect(state.intercepted).toEqual({ boundary: "photo", pagePath: "/" })
    // The page's own envelope says unresolved; the boundary still holds the reloaded target.
    expect(state.boundaries?.photo).toMatchObject({
      status: "ready",
      data: { from: "/photos/2", n: 2 },
    })
    expect(state.boundaries?.user?.status).toBe("unresolved")
  })

  test("revalidate: false reloads nothing unless the server names a path on screen", async () => {
    const { calls, fetchData } = server()
    const router = await opened(fetchData)
    const quiet = actionAnswers()
    calls.length = 0
    await router.submit("/photos/2", new FormData(), { revalidate: false })
    quiet.spy.mockRestore()
    expect(calls).toEqual([])
    expect(router.snapshot().intercepted).toEqual({ boundary: "photo", pagePath: "/" })
    expect(router.snapshot().boundaries?.photo?.status).toBe("ready")

    const named = actionAnswers({ "x-nifra-revalidate": "/photos/2" })
    restore = () => named.spy.mockRestore()
    await router.submit("/photos/2", new FormData(), { revalidate: false })
    expect(calls.map((call) => call.path)).toEqual(["/photos/2"])
    expect(router.snapshot().data).toEqual({ from: "/", n: 0 })
    expect(router.snapshot().boundaries?.photo).toMatchObject({ data: { from: "/photos/2", n: 2 } })
  })

  test("invalidate reloads the paths it names, both without a list", async () => {
    const { calls, fetchData } = server()
    const router = await opened(fetchData)
    calls.length = 0
    await router.invalidate(["/photos/2"])
    expect(calls.map((call) => call.path)).toEqual(["/photos/2"])
    expect(router.snapshot().data).toEqual({ from: "/", n: 0 })
    calls.length = 0
    await router.invalidate(["/"])
    expect(calls.map((call) => call.path)).toEqual(["/"])
    expect(router.snapshot().boundaries?.photo).toMatchObject({ data: { from: "/photos/2", n: 2 } })
    calls.length = 0
    await router.invalidate()
    expect(calls.map((call) => call.path).sort()).toEqual(["/", "/photos/2"])
    expect(router.snapshot().intercepted).toEqual({ boundary: "photo", pagePath: "/" })
  })

  test("a target that now answers with a status, or fails, becomes an error state without its data", async () => {
    const statuses: Record<string, number> = {}
    const failing = new Set<string>()
    const { fetchData } = server(statuses, failing)
    const router = await opened(fetchData)
    statuses["/photos/2"] = 404
    await router.invalidate()
    expect(router.snapshot().boundaries?.photo).toEqual({
      name: "photo",
      mode: { intercept: "/photos/:id" },
      status: "error",
      error: { name: "Error", message: "Boundary failed" },
    })
    expect(router.snapshot().data).toEqual({ from: "/", n: 1 })

    delete statuses["/photos/2"]
    await router.invalidate(["/photos/2"])
    expect(router.snapshot().boundaries?.photo?.status).toBe("ready")
    failing.add("/photos/2")
    await router.invalidate()
    expect(router.snapshot().boundaries?.photo?.status).toBe("error")
    expect(router.snapshot().routeId).toBe("index")
  })

  test("a failed action keeps the boundary open", async () => {
    const { fetchData } = server()
    const router = await opened(fetchData)
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => new Response("no", { status: 500 }), {
        preconnect: globalThis.fetch.preconnect,
      }),
    )
    restore = () => spy.mockRestore()
    await expect(router.submit("/", new FormData())).rejects.toBeDefined()
    expect(router.snapshot().intercepted).toEqual({ boundary: "photo", pagePath: "/" })
    expect(router.snapshot().boundaries?.photo?.status).toBe("ready")
  })

  test("a navigation away offers the page's layouts from the page's path, and closes the boundary", async () => {
    const { calls, fetchData } = server()
    const router = await opened(fetchData)
    calls.length = 0
    await router.navigate("/about")
    expect(calls).toEqual([{ path: "/about", routeId: "about", from: "/" }])
    expect(router.snapshot().intercepted).toBeUndefined()
    expect(router.snapshot().routeId).toBe("about")
  })

  test("navigating to the page's own URL shows the page, not a boundary", async () => {
    const { fetchData } = server()
    const router = await opened(fetchData)
    await router.navigate("/")
    expect(router.snapshot().intercepted).toBeUndefined()
    expect(router.snapshot().path).toBe("/")
    expect(router.snapshot().boundaries?.photo?.status).toBe("unresolved")
  })

  test("a page whose own URL matches its intercept pattern is never intercepted onto itself", async () => {
    const { fetchData } = server()
    const router = createClientRouter({
      patterns,
      initial: {
        routeId: "photo",
        params: { id: "1" },
        path: "/photos/1",
        data: null,
        pending: false,
      },
      fetchData,
      routeHooks: {
        photo: { boundaries: [{ name: "photo", mode: { intercept: "/photos/:id" } }] },
      },
    })
    await router.navigate("/photos/2")
    expect(router.snapshot().intercepted).toEqual({ boundary: "photo", pagePath: "/photos/1" })
    // Back to the page's own URL: the page, not a modal of itself.
    await router.navigate("/photos/1")
    expect(router.snapshot().intercepted).toBeUndefined()
    expect(router.snapshot()).toMatchObject({
      routeId: "photo",
      path: "/photos/1",
      params: { id: "1" },
    })
  })

  test("a client-only search change on the target's route refetches instead of reusing the page's data", async () => {
    const { calls, fetchData } = server()
    const router = createClientRouter({
      patterns,
      initial: {
        routeId: "photo",
        params: { id: "1" },
        path: "/photos/1",
        data: { from: "/photos/1" },
        pending: false,
      },
      fetchData,
      routeHooks: {
        photo: { boundaries: [{ name: "photo", mode: { intercept: "/photos/:id" } }] },
      },
      searchClientKeys: { photo: ["tab"] },
    })
    await router.navigate("/photos/2")
    calls.length = 0
    await router.navigate("/photos/2?tab=info")
    expect(calls.map((call) => call.path)).toEqual(["/photos/2?tab=info"])
    expect(router.snapshot().data).toEqual({ from: "/photos/1" })
    expect(router.snapshot().boundaries?.photo).toMatchObject({
      data: { from: "/photos/2?tab=info" },
    })
  })

  test("opening another intercept boundary closes the first: the URL names one target", async () => {
    const { fetchData } = server()
    const router = await opened(fetchData)
    await router.navigate("/users/7")
    expect(router.snapshot().intercepted).toEqual({ boundary: "user", pagePath: "/" })
    expect(router.snapshot().boundaries?.photo).toEqual(unresolved("photo", "/photos/:id"))
    expect(router.snapshot().boundaries?.user).toMatchObject({
      status: "ready",
      data: { from: "/users/7" },
    })
  })

  test("a link inside the boundary to another target keeps the page underneath", async () => {
    const { fetchData } = server()
    const router = await opened(fetchData)
    await router.navigate("/photos/3")
    expect(router.snapshot().intercepted).toEqual({ boundary: "photo", pagePath: "/" })
    expect(router.snapshot().boundaries?.photo).toMatchObject({ data: { from: "/photos/3" } })
  })

  test("a target that answers with a status is never held: the navigation shows that answer", async () => {
    const { fetchData } = server({ "/photos/9": 404 })
    const router = createClientRouter({
      patterns,
      initial,
      fetchData,
      routeHooks: hooks,
      statusRoutes: { 404: "404" },
    })
    await router.navigate("/photos/9")
    expect(router.snapshot().intercepted).toBeUndefined()
    expect(router.snapshot().routeId).toBe("404")
  })

  test("a clientAction posted to the held target reads the target's data as its server data", async () => {
    const { fetchData } = server()
    let seen: unknown
    const router = createClientRouter({
      patterns,
      initial,
      fetchData,
      statusRoutes: { 404: "404" },
      routeHooks: {
        ...hooks,
        photo: {
          clientAction: async ({ serverLoader }) => {
            seen = await serverLoader()
            return undefined
          },
        },
      },
    })
    await router.navigate("/photos/2")
    const { spy } = actionAnswers()
    restore = () => spy.mockRestore()
    await router.submit("/photos/2", new FormData())
    expect(seen).toEqual({ from: "/photos/2", n: 1 })
  })

  test("an action posted to the target answers the boundary, and the page's actionData stays its own", async () => {
    const { fetchData } = server()
    const router = await opened(fetchData)
    let fail = false
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: string | URL | Request) =>
          fail ? new Response(null, { status: 500 }) : Response.json({ answered: String(input) }),
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    restore = () => spy.mockRestore()

    await router.submit("/photos/2", new FormData())
    let state = router.snapshot()
    expect(state.actionData).toBeUndefined()
    expect(state.boundaries?.photo?.status).toBe("ready")
    expect(state.boundaries?.photo?.actionData).toEqual({ answered: "/photos/2" })

    // The page's action answers the page; the boundary keeps its result across the reload.
    await router.submit("/", new FormData())
    state = router.snapshot()
    expect(state.actionData).toEqual({ answered: "/" })
    expect(state.boundaries?.photo?.data).toEqual({ from: "/photos/2", n: 3 })
    expect(state.boundaries?.photo?.actionData).toEqual({ answered: "/photos/2" })

    // A failed target action leaves both results as they were.
    fail = true
    await expect(router.submit("/photos/2", new FormData())).rejects.toThrow()
    state = router.snapshot()
    expect(state.actionData).toEqual({ answered: "/" })
    expect(state.boundaries?.photo?.actionData).toEqual({ answered: "/photos/2" })

    // Opening another target starts it without a result.
    fail = false
    await router.navigate("/photos/3")
    expect(router.snapshot().boundaries?.photo?.actionData).toBeUndefined()
  })

  test("a clientAction's optimistic result for the held target shows on the boundary", async () => {
    const { fetchData } = server()
    const router = createClientRouter({
      patterns,
      initial,
      fetchData,
      statusRoutes: { 404: "404" },
      routeHooks: {
        ...hooks,
        photo: { clientAction: async () => ({ optimisticData: { optimistic: true } }) },
      },
    })
    await router.navigate("/photos/2")
    const seen: unknown[] = []
    router.subscribe(() => {
      const state = router.snapshot()
      if (state.pending) seen.push([state.actionData, state.boundaries?.photo?.actionData])
    })
    let release: (() => void) | undefined
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return new Response(null, { status: 500 })
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    restore = () => spy.mockRestore()
    const submitted = router.submit("/photos/2", new FormData())
    await Bun.sleep(0)
    expect(seen.at(-1)).toEqual([undefined, { optimistic: true }])
    release?.()
    await expect(submitted).rejects.toThrow()
    expect(router.snapshot().actionData).toBeUndefined()
    expect(router.snapshot().boundaries?.photo?.actionData).toBeUndefined()
  })

  test("opening the boundary leaves the page's actionData as it was", async () => {
    const { fetchData } = server()
    const router = createClientRouter({
      patterns,
      initial: { ...initial, actionData: { saved: true } },
      fetchData,
      routeHooks: hooks,
      statusRoutes: { 404: "404" },
    })
    await router.navigate("/photos/2")
    expect(router.snapshot().intercepted).toEqual({ boundary: "photo", pagePath: "/" })
    expect(router.snapshot().actionData).toEqual({ saved: true })
  })

  test("when the reload after a posted action fails, the full load goes to the route that owns it", async () => {
    const { fetchData } = server({}, new Set(["/"]))
    const router = await opened(fetchData)
    const { spy } = actionAnswers()
    restore = () => spy.mockRestore()
    const pageAction = await router.submit("/", new FormData()).catch((error: unknown) => error)
    expect(redirectOf(pageAction)).toBe("/")
    const targetAction = await router
      .submit("/photos/2", new FormData())
      .catch((error: unknown) => error)
    expect(redirectOf(targetAction)).toBe("/photos/2")
  })

  test("a page that answers a reload with a status is replaced by its status route, closing the boundary", async () => {
    const status: Record<string, number> = {}
    const { fetchData } = server(status)
    const router = await opened(fetchData)
    status["/"] = 404
    await router.invalidate()
    const state = router.snapshot()
    expect(state.routeId).toBe("404")
    expect(state.path).toBe("/photos/2")
    expect(state.intercepted).toBeUndefined()
    expect(state.data).toBeNull()
    expect(state.boundaries).toBeUndefined()
  })

  test("an action whose page reload answers with a status shows the status route, not the boundary", async () => {
    const status: Record<string, number> = {}
    const { fetchData } = server(status)
    const router = await opened(fetchData)
    const { spy } = actionAnswers()
    restore = () => spy.mockRestore()
    status["/"] = 404
    await router.submit("/photos/2", new FormData())
    const state = router.snapshot()
    expect(state.routeId).toBe("404")
    expect(state.intercepted).toBeUndefined()
    expect(state.actionData).toBeUndefined()
    expect(state.boundaries).toBeUndefined()
  })

  test("after the page answered a status, the next reload loads the URL's own route, never into the status page", async () => {
    const status: Record<string, number> = {}
    const { calls, fetchData } = server(status)
    const router = await opened(fetchData)
    status["/"] = 404
    await router.invalidate()
    expect(router.snapshot().routeId).toBe("404")

    // The URL is still the photo's: its own route reloads it, with its own data.
    calls.length = 0
    await router.invalidate()
    expect(calls.map((call) => `${call.routeId} ${call.path}`)).toEqual(["photo /photos/2"])
    let state = router.snapshot()
    expect(state.routeId).toBe("photo")
    expect(state.params).toEqual({ id: "2" })
    expect(state.data).toEqual({ from: "/photos/2", n: 3 })

    // A status page whose URL still answers with a status stays the status page, with no data.
    await router.navigate("/users/7")
    status["/users/7"] = 404
    await router.invalidate()
    state = router.snapshot()
    expect(state.routeId).toBe("404")
    expect(state.data).toBeNull()
    delete status["/users/7"]
    await router.invalidate()
    state = router.snapshot()
    expect(state.routeId).toBe("user")
    expect(state.data).toEqual({ from: "/users/7", n: 3 })
  })

  test("navigating to the target the boundary already shows keeps it, with its action result, and fetches nothing", async () => {
    const { calls, fetchData } = server()
    const router = await opened(fetchData)
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => Response.json({ commented: true }), {
        preconnect: globalThis.fetch.preconnect,
      }),
    )
    restore = () => spy.mockRestore()
    await router.submit("/photos/2", new FormData())
    const before = router.snapshot()
    calls.length = 0
    let emitted = 0
    router.subscribe(() => {
      emitted++
    })
    await router.navigate("/photos/2")
    expect(calls).toEqual([])
    expect(emitted).toBe(1)
    expect(router.snapshot()).toBe(before)
    expect(router.snapshot().boundaries?.photo?.actionData).toEqual({ commented: true })
  })
})
