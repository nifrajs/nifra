/**
 * A navigation owns the page until something newer does. Whatever the newer one is - a Back out of a
 * boundary, a search-only change, a submit, a reload, the first client load - the older navigation's
 * late answer is dropped, and it stays dropped when yet another navigation starts after.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  type ClientRouter,
  createClientRouter,
  type FetchRouteData,
  type RouterState,
} from "../src/index.ts"

const patterns = [
  { routeId: "index", pattern: "/" },
  { routeId: "photo", pattern: "/photos/:id" },
  { routeId: "about", pattern: "/about" },
]

const initial: RouterState = {
  routeId: "index",
  params: {},
  path: "/",
  data: { from: "/" },
  pending: false,
}

// `/about` answers only when released, numbering its requests in the order they were made.
function slowAbout() {
  const releases: Array<() => void> = []
  const fetchData: FetchRouteData = async (path) => {
    if (path !== "/about") return { from: path }
    const call = releases.length + 1
    await new Promise<void>((resolve) => releases.push(resolve))
    return { from: path, call }
  }
  return { fetchData, release: (call: number) => releases[call - 1]?.() }
}

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

type Supersede = {
  readonly name: string
  readonly router: (fetchData: FetchRouteData) => ClientRouter
  readonly run: (router: ClientRouter) => Promise<() => Promise<unknown>>
}

const held = {
  routeId: "index",
  params: {},
  path: "/",
  data: { from: "/" },
  boundaries: {
    photo: { name: "photo", mode: { intercept: "/photos/:id" }, status: "unresolved" as const },
  },
  pending: false,
}

const supersedes: Supersede[] = [
  {
    name: "a Back out of an intercept boundary",
    router: (fetchData) =>
      createClientRouter({
        patterns,
        initial: held,
        fetchData,
        routeHooks: {
          index: { boundaries: [{ name: "photo", mode: { intercept: "/photos/:id" } }] },
        },
      }),
    run: async (router) => {
      await router.navigate("/photos/2")
      return () => router.navigate("/")
    },
  },
  {
    name: "a search-only change",
    router: (fetchData) =>
      createClientRouter({
        patterns,
        initial: { ...initial, routeId: "photo", params: { id: "1" }, path: "/photos/1" },
        fetchData,
        searchClientKeys: { photo: ["tab"] },
      }),
    run: async (router) => () => router.navigate("/photos/1?tab=info"),
  },
  {
    name: "a submit",
    router: (fetchData) => createClientRouter({ patterns, initial, fetchData }),
    run: async (router) => {
      const spy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(async () => Response.json({ ok: true }), {
          preconnect: globalThis.fetch.preconnect,
        }),
      )
      restore = () => spy.mockRestore()
      return () => router.submit("/act", new FormData())
    },
  },
  {
    name: "a reload of the page",
    router: (fetchData) => createClientRouter({ patterns, initial, fetchData }),
    run: async (router) => () => router.invalidate(),
  },
  {
    name: "the first client load",
    router: (fetchData) =>
      createClientRouter({
        patterns,
        initial,
        fetchData,
        routeHooks: { index: { clientLoader: async ({ serverLoader }) => serverLoader() } },
      }),
    run: async (router) => () => router.hydrate(),
  },
]

describe("a superseded navigation", () => {
  for (const later of supersedes) {
    test(`drops an older navigation once ${later.name} supersedes it`, async () => {
      const about = slowAbout()
      const router = later.router(about.fetchData)
      const supersede = await later.run(router)
      const first = router.navigate("/about")
      await supersede()
      about.release(1)
      await first
      expect(router.snapshot().routeId).not.toBe("about")
    })

    test(`stays dropped after ${later.name}, and a navigation after that still lands`, async () => {
      const about = slowAbout()
      const router = later.router(about.fetchData)
      const supersede = await later.run(router)
      const first = router.navigate("/about")
      await supersede()
      const third = router.navigate("/about")
      about.release(1)
      await first
      expect(router.snapshot().routeId).not.toBe("about")
      about.release(2)
      await third
      expect(router.snapshot()).toMatchObject({ routeId: "about", data: { call: 2 } })
    })
  }
})
