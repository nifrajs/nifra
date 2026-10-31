/**
 * What the client router sends and accepts on the wire: the status envelope's bounds, the request
 * headers, the layouts a server may say the client keeps, and a client action's answer.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createClientRouter, type FetchRouteData, type RouterState } from "../src/index.ts"
import {
  DATA_HEADER,
  HOLE_FILL_HEADER,
  NAV_FROM_HEADER,
  RETAIN_HEADER,
  routeDataHeaders,
  routeDataOf,
  STATUS_HEADER,
} from "../src/router.ts"

const patterns = [
  { routeId: "index", pattern: "/" },
  { routeId: "about", pattern: "/about" },
  { routeId: "act", pattern: "/act" },
  { routeId: "photo", pattern: "/photos/:id" },
]

const initial: RouterState = {
  routeId: "index",
  params: {},
  path: "/",
  data: { from: "/" },
  pending: false,
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

describe("a data response's status header", () => {
  const answer = (status: string) =>
    routeDataOf(new Response('{"kept":true}', { headers: { [STATUS_HEADER]: status } }), "/p")

  test("is a terminal answer from 400 to 599, whole numbers only", async () => {
    for (const status of [400, 404, 599])
      expect(await answer(String(status))).toEqual({ v: 1, data: null, status })
    for (const status of ["399", "600", "404.5", "abc", ""])
      expect(await answer(status)).toEqual({ kept: true })
  })

  test("is absent from a response that failed without one", async () => {
    await expect(routeDataOf(new Response("no", { status: 500 }), "/p")).rejects.toThrow(
      "navigation data fetch failed (500): /p",
    )
  })
})

describe("a data request's headers", () => {
  const sent = (...args: Parameters<typeof routeDataHeaders>) =>
    Object.fromEntries(routeDataHeaders(...args))

  test("carry the data marker and nothing else when there is nothing to say", () => {
    expect(sent(undefined, undefined)).toEqual({ [DATA_HEADER]: "1" })
    expect(sent({ from: "/x", retain: [] }, [])).toEqual({ [DATA_HEADER]: "1" })
  })

  test("name the holes it fills and the layouts it keeps, with the page they came from", () => {
    expect(sent({ from: "/x", retain: [0, 2] }, ["a", "b"])).toEqual({
      [DATA_HEADER]: "1",
      [HOLE_FILL_HEADER]: "a,b",
      [RETAIN_HEADER]: "0,2",
      [NAV_FROM_HEADER]: "/x",
    })
  })
})

describe("a terminal status", () => {
  test("with no status route to render it rejects the navigation", async () => {
    const fetchData: FetchRouteData = async () => ({ v: 1, data: null, status: 503 })
    const router = createClientRouter({ patterns, initial, fetchData })
    await expect(router.navigate("/about")).rejects.toThrow(
      "no client status boundary is available for terminal status 503",
    )
    expect(router.snapshot()).toMatchObject({ routeId: "index", pending: false })
  })
})

describe("the layouts a server says the client keeps", () => {
  test("are only the ones the client holds", async () => {
    const held = { layout: "held" }
    const fetchData: FetchRouteData = async () => ({
      v: 1,
      data: { page: 1 },
      layoutData: [{ layout: "sent 0" }, { layout: "sent 1" }],
      retained: [0, 1, 1.5, -1],
    })
    const router = createClientRouter({
      patterns,
      initial: { ...initial, layoutData: [held] },
      fetchData,
    })
    await router.navigate("/about")
    const layouts = router.snapshot().layoutData
    expect(layouts?.[0]).toBe(held)
    expect(layouts?.[1]).toEqual({ layout: "sent 1" })
    expect(layouts).toHaveLength(2)
  })
})

describe("a client action", () => {
  const routerWith = (clientAction: (args: { body: unknown }) => unknown) =>
    createClientRouter({
      patterns,
      initial,
      fetchData: async () => ({ from: "/" }),
      routeHooks: {
        act: {
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The hook under test returns whatever the case hands it, including values the declared type forbids.
          clientAction: clientAction as never,
        },
      },
    })

  test("must answer with an object or nothing", async () => {
    for (const answer of [null, [], "text", 7]) {
      const router = routerWith(() => answer)
      await expect(router.submit("/act", new FormData())).rejects.toThrow(
        "clientAction must return an object or undefined",
      )
    }
  })

  test("shows an optimistic answer while the post is out, and shows none when it gives none", async () => {
    let release: (() => void) | undefined
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          await new Promise<void>((resolve) => (release = resolve))
          return Response.json({ ok: true })
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    restore = () => spy.mockRestore()
    for (const [answer, optimistic] of [
      [{}, false],
      [{ optimisticData: { saving: true } }, true],
    ] as const) {
      const router = routerWith(() => answer)
      const seen: RouterState[] = []
      router.subscribe(() => seen.push(router.snapshot()))
      const posting = router.submit("/act", new FormData())
      await flush()
      expect(release).toBeDefined()
      expect(seen).toHaveLength(optimistic ? 2 : 1)
      expect(router.snapshot().actionData).toEqual(optimistic ? { saving: true } : undefined)
      release?.()
      release = undefined
      await posting
    }
  })
})

describe("an intercept pattern", () => {
  const photo = (intercept: string) =>
    createClientRouter({
      patterns,
      initial,
      fetchData: async (path) => ({ from: path }),
      routeHooks: { index: { boundaries: [{ name: "photo", mode: { intercept } }] } },
    })

  test("opens a boundary when it matches", async () => {
    const router = photo("/photos/:id")
    await router.navigate("/photos/2")
    expect(router.snapshot().intercepted).toEqual({ boundary: "photo", pagePath: "/" })
  })

  test("longer than 2048 characters is ignored, and the navigation shows its page", async () => {
    const router = photo(`/photos/:${"a".repeat(2100)}`)
    await router.navigate("/photos/2")
    expect(router.snapshot()).toMatchObject({ routeId: "photo", path: "/photos/2" })
    expect(router.snapshot().intercepted).toBeUndefined()
  })
})

describe("a loader's redirect", () => {
  const redirecting = (to: string) => {
    const moved = Object.assign(new Error("moved"), { redirectTo: to })
    const router = createClientRouter({
      patterns,
      initial,
      fetchData: async (path) => {
        if (path === "/about") throw moved
        return { from: path }
      },
    })
    return { router, moved }
  }

  test("to a route of the app is followed there", async () => {
    const { router } = redirecting("/photos/3?tab=a")
    await router.navigate("/about")
    expect(router.snapshot()).toMatchObject({ routeId: "photo", path: "/photos/3?tab=a" })
  })

  for (const to of [
    "//evil.test/photos/3",
    "/\\evil.test/photos/3",
    "https://evil.test/photos/3",
    "/photos/3#top",
    "photos/3",
    "/nowhere",
  ])
    test(`to ${to} is left to the browser: the navigation rejects and the page stays`, async () => {
      const { router, moved } = redirecting(to)
      await expect(router.navigate("/about")).rejects.toBe(moved)
      expect(router.snapshot()).toMatchObject({ routeId: "index", path: "/", pending: false })
    })
})
