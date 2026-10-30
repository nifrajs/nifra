import { describe, expect, test } from "bun:test"
import {
  getRouteSlotRuntime,
  loadRouteSlot,
  RouteSlotLoadError,
  type RouteSlotRuntime,
  withRouteSlotConcurrency,
} from "../src/internal/route-slot-runtime.ts"
import type { RouteMatch } from "../src/router.ts"

const makeRuntime = (): RouteSlotRuntime => {
  const matches: Record<string, RouteMatch> = {
    "/dashboard": { routeId: "dashboard", params: {} },
    "/users/7": { routeId: "user", params: { id: "7" } },
    "/admin/1": { routeId: "admin", params: { id: "1" } },
  }
  const router = {
    match(path: string) {
      return matches[new URL(path, "https://nifra.invalid").pathname] ?? null
    },
    routeSlotsFor(routeId: string) {
      return routeId === "dashboard" ? { inspector: ["/users/:id"] } : {}
    },
    routePattern(routeId: string) {
      return routeId === "user" ? "/users/:id" : routeId === "admin" ? "/admin/:id" : "/dashboard"
    },
    async loadModule() {},
  } satisfies RouteSlotRuntime["router"]
  return {
    router,
    routes: { user: [() => null] },
    searchSchemas: undefined,
    matchChains: undefined,
  }
}

describe("route-slot loading", () => {
  test("loads through the same-origin route-data request and returns the target chain", async () => {
    const originalFetch = globalThis.fetch
    let request: { url: string; headers: Headers } | undefined
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        request = { url: String(input), headers: new Headers(init?.headers) }
        return new Response(
          JSON.stringify({ v: 1, data: { name: "Ada" }, layoutData: [{ org: "demo" }] }),
          { headers: { "content-type": "application/json" } },
        )
      },
      { preconnect: originalFetch.preconnect },
    )
    try {
      const runtime = makeRuntime()
      const loaded = await loadRouteSlot(
        runtime,
        "inspector",
        "/dashboard?tab=overview",
        "/users/7?tab=posts",
        new AbortController().signal,
      )
      expect(request?.url).toBe("/users/7?tab=posts")
      expect(request?.headers.get("x-nifra-data")).toBe("1")
      expect(loaded).toMatchObject({
        routeId: "user",
        path: "/users/7?tab=posts",
        parentPath: "/dashboard?tab=overview",
        params: { id: "7" },
        search: { tab: "posts" },
        data: { name: "Ada" },
        layoutData: [{ org: "demo" }],
        chain: runtime.routes.user,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("denies a target outside the page allowlist before making a request", async () => {
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        requests++
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
      { preconnect: originalFetch.preconnect },
    )
    try {
      let failure: unknown
      try {
        await loadRouteSlot(
          makeRuntime(),
          "inspector",
          "/dashboard",
          "/admin/1",
          new AbortController().signal,
        )
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ code: "unavailable" })
      expect(requests).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("maps route-data authorization failures to a stable forbidden state", async () => {
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        requests++
        return new Response(JSON.stringify({ v: 1, data: null, status: 403 }), {
          headers: { "content-type": "application/json" },
        })
      },
      { preconnect: originalFetch.preconnect },
    )
    try {
      const failure = await loadRouteSlot(
        makeRuntime(),
        "inspector",
        "/dashboard",
        "/users/7",
        new AbortController().signal,
      ).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(RouteSlotLoadError)
      expect(failure).toMatchObject({ code: "forbidden" })
      expect(requests).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("caps simultaneous requests and bounds queued work", async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let active = 0
    let peak = 0
    const signal = (): AbortSignal => new AbortController().signal
    const tasks = Array.from({ length: 12 }, () =>
      withRouteSlotConcurrency(signal(), async () => {
        active++
        peak = Math.max(peak, active)
        await gate
        active--
        return true
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(peak).toBe(4)
    await expect(withRouteSlotConcurrency(signal(), async () => true)).rejects.toThrow(
      "route-slot loader concurrency limit exceeded",
    )
    release()
    expect(await Promise.all(tasks)).toHaveLength(12)
    expect(peak).toBe(4)
  })
})

describe("route slot runtime global", () => {
  test("fails closed for malformed cross-bundle runtime records", () => {
    const key = Symbol.for("nifra.web.route-slot-runtime")
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    const router: RouteSlotRuntime["router"] = {
      match: () => null,
      loadModule: async () => undefined,
      routeSlotsFor: () => ({}),
      routePattern: () => undefined,
    }
    const accessorRuntime = Object.defineProperty({ routes: {} }, "router", {
      get() {
        throw new Error("runtime getter must not run")
      },
    })
    const invalid: readonly unknown[] = [
      { router: {}, routes: {} },
      { router, routes: { route: {} } },
      { router, routes: {}, searchSchemas: { route: [{}] } },
      { router, routes: {}, matchChains: { route: { ids: ["route"], handles: [] } } },
      accessorRuntime,
    ]

    try {
      for (const runtime of invalid) {
        Reflect.set(globalThis, key, runtime)
        expect(getRouteSlotRuntime()).toBeUndefined()
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, previous)
    }
  })
})
