import { afterEach, describe, expect, test } from "bun:test"
import { identityChanged } from "../src/identity.ts"
import type { LoadedRouteSlot } from "../src/internal/route-slot-runtime.ts"
import {
  getRouteSlotRuntime,
  getRouteSlotStore,
  loadRouteSlot,
  onRouteSlotIdentityChange,
  RouteSlotLoadError,
  type RouteSlotRuntime,
  RouteSlotStore,
  setRouteSlotRuntime,
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

  test("maps a raw authorization response to a stable forbidden state", async () => {
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        requests++
        return new Response(null, { status: 403 })
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

  test("does not render HTML returned after a route-data request follows a login redirect", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (): Promise<Response> =>
        new Response("<html>login</html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
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
      expect(failure).toMatchObject({ code: "unavailable" })
      expect(failure).not.toHaveProperty("content")
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

  test("aborting a queued load removes it without consuming a concurrency slot", async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = Array.from({ length: 4 }, () =>
      withRouteSlotConcurrency(new AbortController().signal, async () => gate),
    )
    await settle()

    const queuedController = new AbortController()
    const queued = withRouteSlotConcurrency(queuedController.signal, async () => true)
    await settle()
    queuedController.abort(new Error("navigation changed"))
    await expect(queued).rejects.toThrow("navigation changed")

    release()
    await Promise.all(running)
    await expect(
      withRouteSlotConcurrency(new AbortController().signal, async () => true),
    ).resolves.toBe(true)
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

  test("rejects proxy-backed and accessor-backed runtime records without invoking getters", () => {
    const key = Symbol.for("nifra.web.route-slot-runtime")
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    const router: RouteSlotRuntime["router"] = {
      match: () => null,
      loadModule: async () => undefined,
      routeSlotsFor: () => ({}),
      routePattern: () => undefined,
    }
    const proxyPrototype = new Proxy(
      { router, routes: {} },
      {
        getPrototypeOf() {
          throw new Error("prototype trap must not escape")
        },
      },
    )
    const proxyProperty = new Proxy(
      { router, routes: {} },
      {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap must not escape")
        },
      },
    )
    const accessorRoutes = {
      router,
      routes: Object.defineProperty({}, "user", {
        get() {
          throw new Error("route getter must not run")
        },
      }),
    }

    try {
      for (const runtime of [proxyPrototype, proxyProperty, accessorRoutes]) {
        Reflect.set(globalThis, key, runtime)
        expect(getRouteSlotRuntime()).toBeUndefined()
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, previous)
    }
  })
})

function loaded(path: string): LoadedRouteSlot {
  return {
    routeId: "/users/:id",
    path,
    params: { id: path.split("/").at(-1) ?? "" },
    search: {},
    data: null,
    parentPath: "/dashboard",
    chain: [],
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error("deferred promise was not initialized")
      resolvePromise(value)
    },
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index++) await Promise.resolve()
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
const focusListeners = new Set<() => void>()

function installFocusWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener(type: string, listener: () => void) {
        if (type === "focus") focusListeners.add(listener)
      },
      removeEventListener(type: string, listener: () => void) {
        if (type === "focus") focusListeners.delete(listener)
      },
    },
  })
}

function restoreWindow(): void {
  focusListeners.clear()
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window")
  else Object.defineProperty(globalThis, "window", originalWindow)
}

afterEach(restoreWindow)

describe("route-slot store", () => {
  test("sync publishes stable error and idle states and ignores duplicate writes", () => {
    const store = new RouteSlotStore("sync-states")
    const notifications: string[] = []
    const unsubscribe = store.subscribe(() => notifications.push(store.getSnapshot().status))

    store.sync("bad-target", undefined, "forbidden")
    store.sync("bad-target", undefined, "unauthorized")
    expect(store.getSnapshot()).toMatchObject({ status: "error", error: "forbidden" })
    store.sync("no-target")
    store.sync("no-target")
    expect(store.getSnapshot()).toMatchObject({ status: "idle", key: "no-target" })
    expect(notifications).toEqual(["error", "idle"])

    unsubscribe()
    store.dispose()
  })

  test("runtime replacement reloads active stores and identity notifications reach subscribers", async () => {
    installFocusWindow()
    const key = Symbol.for("nifra.web.route-slot-runtime")
    const previousRuntime = Object.getOwnPropertyDescriptor(globalThis, key)
    const store = getRouteSlotStore("/runtime-replacement", "inspector")
    let loads = 0
    const unsubscribe = store.subscribe(() => {})
    const stopIdentity = onRouteSlotIdentityChange(() => {
      loads += 100
    })
    store.sync("target", async () => {
      loads++
      return loaded("/users/7")
    })

    try {
      await settle()
      expect(loads).toBe(1)
      const runtime = makeRuntime()
      setRouteSlotRuntime(runtime)
      await settle()
      expect(loads).toBe(2)
      setRouteSlotRuntime(runtime)
      identityChanged()
      expect(loads).toBe(102)
    } finally {
      stopIdentity()
      unsubscribe()
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (previousRuntime === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, previousRuntime)
    }
  })

  test("multiple controllers share one in-flight load for the same slot target", async () => {
    const store = new RouteSlotStore("deduplicate")
    const request = deferred<LoadedRouteSlot>()
    let calls = 0
    const stopFirst = store.subscribe(() => {})
    const stopSecond = store.subscribe(() => {})
    const loader = () => {
      calls++
      return request.promise
    }

    store.sync("same-target", loader)
    await settle()
    store.sync("same-target", loader)
    expect(calls).toBe(1)
    request.resolve(loaded("/users/7"))
    await settle()
    expect(store.getSnapshot().content?.path).toBe("/users/7")
    stopFirst()
    stopSecond()
  })

  test("aborts stale loads when navigation changes the target", async () => {
    const store = new RouteSlotStore("navigation")
    const first = deferred<LoadedRouteSlot>()
    let firstSignal: AbortSignal | undefined
    const unsubscribe = store.subscribe(() => {})

    store.sync("first", (signal) => {
      firstSignal = signal
      return first.promise
    })
    await settle()
    store.sync("second", async () => loaded("/users/2"))
    first.resolve(loaded("/users/1"))
    await settle()

    expect(firstSignal?.aborted).toBe(true)
    expect(store.getSnapshot()).toMatchObject({
      key: "second",
      status: "ready",
      content: { path: "/users/2" },
    })
    unsubscribe()
  })

  test("identity change clears prior content and reloads the authorized target", async () => {
    const store = new RouteSlotStore("identity")
    const second = deferred<LoadedRouteSlot>()
    let calls = 0
    const unsubscribe = store.subscribe(() => {})

    store.sync("same-target", async () => {
      calls++
      return calls === 1 ? loaded("/users/1") : second.promise
    })
    await settle()
    expect(store.getSnapshot().content?.path).toBe("/users/1")

    identityChanged()
    expect(store.getSnapshot()).toMatchObject({ key: "same-target", status: "loading" })
    expect(store.getSnapshot().content).toBeUndefined()
    await settle()
    expect(calls).toBe(2)

    second.resolve(loaded("/users/1?as=next-identity"))
    await settle()
    expect(store.getSnapshot().content?.path).toBe("/users/1?as=next-identity")
    unsubscribe()
  })

  test("focus refresh keeps ready content visible and throttles repeat requests", async () => {
    installFocusWindow()
    const store = new RouteSlotStore("focus")
    const refresh = deferred<LoadedRouteSlot>()
    let calls = 0
    const unsubscribe = store.subscribe(() => {})
    store.sync("target", async () => {
      calls++
      return calls === 1 ? loaded("/users/1") : refresh.promise
    })
    await settle()
    expect(store.getSnapshot().status).toBe("ready")

    for (const listener of focusListeners) listener()
    await settle()
    expect(calls).toBe(2)
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      content: { path: "/users/1" },
    })
    for (const listener of focusListeners) listener()
    expect(calls).toBe(2)

    refresh.resolve(loaded("/users/1?fresh=1"))
    await settle()
    expect(store.getSnapshot().content?.path).toBe("/users/1?fresh=1")
    unsubscribe()
  })

  test("a failed focus refresh keeps the last authorized content", async () => {
    installFocusWindow()
    const store = new RouteSlotStore("focus-error")
    let calls = 0
    const unsubscribe = store.subscribe(() => {})
    store.sync("target", async () => {
      calls++
      if (calls === 1) return loaded("/users/1")
      throw new Error("refresh failed")
    })
    await settle()

    for (const listener of focusListeners) listener()
    await settle()
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      content: { path: "/users/1" },
    })
    unsubscribe()
  })

  test("unsubscribing the last consumer aborts its active request", async () => {
    const store = new RouteSlotStore("unmount")
    const request = deferred<LoadedRouteSlot>()
    let signal: AbortSignal | undefined
    const unsubscribe = store.subscribe(() => {})
    store.sync("target", (activeSignal) => {
      signal = activeSignal
      return request.promise
    })

    unsubscribe()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(signal?.aborted).toBe(true)
    expect(store.disposed).toBe(true)
  })

  test("the store cache does not evict active subscriptions", async () => {
    installFocusWindow()
    const first = getRouteSlotStore("/store-cap", "slot-0")
    const unsubscribe = first.subscribe(() => {})
    const remaining: Array<() => void> = []
    for (let index = 1; index <= 16; index++) {
      const store = getRouteSlotStore("/store-cap", `slot-${index}`)
      remaining.push(store.subscribe(() => {}))
    }

    expect(first.disposed).toBe(false)
    expect(getRouteSlotStore("/store-cap", "slot-0")).toBe(first)
    unsubscribe()
    for (const stop of remaining) stop()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  test("the store cache evicts only disposed idle entries after reaching its cap", () => {
    installFocusWindow()
    const first = getRouteSlotStore("/idle-store-cap", "slot-0")
    for (let index = 1; index <= 16; index++) getRouteSlotStore("/idle-store-cap", `slot-${index}`)

    expect(first.disposed).toBe(true)
    expect(getRouteSlotStore("/idle-store-cap", "slot-0")).not.toBe(first)
  })
})
