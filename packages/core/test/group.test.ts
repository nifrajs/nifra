import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { withRouteAssurance } from "../src/assurance.ts"
import { useCapability } from "../src/capabilities.ts"
import { effectLedger } from "../src/effect-ledger.ts"
import { idempotency } from "../src/idempotency-plugin.ts"
import {
  authenticated,
  FrameworkError,
  RouteConfigError,
  rejected,
  server,
  silentLogger,
} from "../src/index.ts"
import { mcp } from "../src/mcp.ts"
import { nodeDirect } from "../src/node-direct.ts"
import { responseObserver } from "../src/response-observer.ts"
import { websocket } from "../src/ws.ts"

const get = (app: { fetch(req: Request): Promise<Response> | Response }, path: string) =>
  Promise.resolve(app.fetch(new Request(`http://x${path}`)))

const routeKeys = (app: { routes(): readonly { method: string; path: string }[] }) =>
  app.routes().map(({ method, path }) => `${method} ${path}`)

describe("group() - prefixed routes", () => {
  test("routes serve under the prefix; a '/' route serves the prefix itself", async () => {
    const app = server()
      .get("/", () => ({ at: "root" }))
      .group("/api", (api) =>
        api
          .get("/", () => ({ at: "api" }))
          .get("/users/:id", (c) => ({ id: c.params.id }))
          .post("/users", { body: t.object({ name: t.string() }) }, (c) => ({ made: c.body.name })),
      )
      .get("/after", () => ({ at: "after" }))

    expect(await (await get(app, "/")).json()).toEqual({ at: "root" })
    expect(await (await get(app, "/api")).json()).toEqual({ at: "api" })
    expect(await (await get(app, "/api/users/u1")).json()).toEqual({ id: "u1" })
    expect(await (await get(app, "/after")).json()).toEqual({ at: "after" })
    // The unprefixed spelling was never registered.
    expect((await get(app, "/users/u1")).status).toBe(404)
    expect((await get(app, "/api/")).status).toBe(404)
    const created = await app.fetch(
      new Request("http://x/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ada" }),
      }),
    )
    expect(await created.json()).toEqual({ made: "ada" })
    expect(routeKeys(app)).toEqual([
      "GET /",
      "GET /api",
      "GET /api/users/:id",
      "POST /api/users",
      "GET /after",
    ])
  })

  test("groups nest, joining their prefixes", async () => {
    const app = server().group("/api", (api) =>
      api
        .get("/ping", () => "pong")
        .group("/v1", (v1) => v1.get("/", () => "v1 root").get("/users", () => ["u"])),
    )
    expect(routeKeys(app)).toEqual(["GET /api/ping", "GET /api/v1", "GET /api/v1/users"])
    expect(await (await get(app, "/api/v1/users")).json()).toEqual(["u"])
    expect(await (await get(app, "/api/v1")).json()).toBe("v1 root")
  })

  test("a group inherits the chain as it stands at the call, and its additions stay inside", async () => {
    const trail: string[] = []
    const app = server()
      .derive(() => ({ tenant: "t1" }))
      .decorate("version", "v9")
      .beforeHandle(() => {
        trail.push("parent-before")
      })
      .group("/admin", (admin) =>
        admin
          .derive(() => ({ role: "admin" }))
          .beforeHandle(() => {
            trail.push("group-before")
          })
          .get("/me", (c) => ({ tenant: c.tenant, version: c.version, role: c.role })),
      )
      .get("/public", (c) => ({ tenant: c.tenant, role: (c as { role?: string }).role ?? null }))

    expect(await (await get(app, "/admin/me")).json()).toEqual({
      tenant: "t1",
      version: "v9",
      role: "admin",
    })
    expect(trail).toEqual(["parent-before", "group-before"])
    trail.length = 0
    expect(await (await get(app, "/public")).json()).toEqual({ tenant: "t1", role: null })
    // The group's beforeHandle never reaches a parent route declared after the group.
    expect(trail).toEqual(["parent-before"])
  })

  test("a parent chain step added after the group does not wrap the group's routes", async () => {
    let parentAfter = 0
    const app = server()
      .group("/g", (g) => g.get("/x", () => "x"))
      .beforeHandle(() => {
        parentAfter += 1
      })
      .get("/y", () => "y")
    await get(app, "/g/x")
    expect(parentAfter).toBe(0)
    await get(app, "/y")
    expect(parentAfter).toBe(1)
  })

  test("an inherited authenticate() stage gates group routes and proves authentication", async () => {
    const app = server()
      .authenticate({
        id: "bearer",
        mode: "sync",
        run: (input) =>
          input.headers.get("authorization") === "Bearer ok"
            ? authenticated({ userId: "u1" })
            : rejected(),
      })
      .group("/me", (me) => me.get("/", (c) => ({ user: c.principal.userId })))

    expect((await get(app, "/me")).status).toBe(401)
    const ok = await app.fetch(
      new Request("http://x/me", { headers: { authorization: "Bearer ok" } }),
    )
    expect(await ok.json()).toEqual({ user: "u1" })
    const route = app.routes().find((r) => r.path === "/me")
    expect(route?.assurance?.some((e) => e.id === "nifra.authenticated")).toBe(true)
  })

  test("capability events, the effect ledger, and idempotency see the full prefixed path", async () => {
    const events: string[] = []
    const ledgers: { path: string }[] = []
    let runs = 0
    const app = server({
      onCapabilityUse: (event) => {
        events.push(`${event.method} ${event.path} ${event.capability}`)
      },
    })
      .use(idempotency())
      .use(
        effectLedger({
          sink: (ledger) => {
            ledgers.push(ledger as unknown as { path: string })
          },
        }),
      )
      .group("/billing", (billing) =>
        billing.post(
          "/charge",
          {
            capabilities: ["payments.charge"],
            idempotency: { scope: "request", namespace: "public:charge" },
          },
          (c) => {
            runs += 1
            useCapability(c, "payments.charge")
            return { run: runs }
          },
        ),
      )
    const charge = () =>
      app.fetch(
        new Request("http://x/billing/charge", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "k1" },
          body: "{}",
        }),
      )
    expect(await (await charge()).json()).toEqual({ run: 1 })
    expect(await (await charge()).json()).toEqual({ run: 1 })
    expect(runs).toBe(1)
    expect(events).toEqual(["POST /billing/charge payments.charge"])
    expect(ledgers.map((ledger) => ledger.path)).toEqual(["/billing/charge"])
  })

  test("a group's own global assurance is folded onto its routes only", () => {
    const guard = withRouteAssurance(
      { name: "group-body-guard", onRequest: () => undefined },
      { id: "nifra.body-bounded", source: "body-limit", scope: "global", methods: ["POST"] },
    )
    const app = server()
      .group("/uploads", (uploads) => uploads.use(guard).post("/", () => ({ ok: true })))
      .post("/own", () => ({ ok: true }))
    const byPath = new Map(app.routes().map((r) => [r.path, r.assurance]))
    expect(byPath.get("/uploads")?.some((e) => e.id === "nifra.body-bounded")).toBe(true)
    expect(byPath.get("/own")?.some((e) => e.id === "nifra.body-bounded") ?? false).toBe(false)
  })
})

describe("group() - request/response hooks are scoped to the prefix", () => {
  test("group onRequest runs for the prefix and below (served, 404, 405), never elsewhere", async () => {
    const seen: string[] = []
    const app = server()
      .get("/apix", () => "not under /api")
      .group("/api", (api) =>
        api
          .onRequest((req) => {
            seen.push(`${req.method} ${new URL(req.url).pathname}`)
            return undefined
          })
          .get("/", () => "root")
          .get("/x", () => "x"),
      )
      .get("/other", () => "other")

    for (const path of ["/api", "/api/x", "/api/missing", "/apix", "/other", "/"]) {
      await get(app, path)
    }
    await app.fetch(new Request("http://x/api/x", { method: "DELETE" }))
    expect(seen).toEqual(["GET /api", "GET /api/x", "GET /api/missing", "DELETE /api/x"])
  })

  test("regression: no URL spelling reaches a group route without the group's request gate", async () => {
    let handled = 0
    const app = server().group("/api", (api) =>
      api
        .onRequest((req) =>
          req.headers.get("x-key") === "k" ? undefined : new Response(null, { status: 401 }),
        )
        .get("/", () => {
          handled += 1
          return "root"
        })
        .get("/x", () => {
          handled += 1
          return "x"
        })
        .get("/x/:id", () => {
          handled += 1
          return "id"
        }),
    )
    const spellings = [
      "/api",
      "/api/x",
      "/api/x/1",
      "//api/x",
      "/api//x",
      "/api/x/",
      "/API/x",
      "/api/./x",
      "/api/../api/x",
      "/./api/x",
      "/api/%78",
      "/%61pi/x",
      "/api/x?q=1",
      "/api/x#frag",
      "/api/x%2F1",
      "/api%2Fx",
      "/api;/x",
    ]
    const statuses: Record<string, number> = {}
    for (const path of spellings) statuses[path] = (await get(app, path)).status
    expect(handled).toBe(0)
    for (const path of spellings) expect(statuses[path]).not.toBe(200)
    // Sanity: the gate opens with the key, so the zero above is the gate, not a routing miss.
    const keyed = await app.fetch(new Request("http://x/api/x", { headers: { "x-key": "k" } }))
    expect(keyed.status).toBe(200)
    expect(handled).toBe(1)
  })

  test("the same regression holds on the Node-direct lane with paired twins", async () => {
    const webSeen: string[] = []
    const nodeSeen: string[] = []
    let handled = 0
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .group("/api", (api) =>
        api
          .use({
            name: "api-gate",
            onRequest: (req) => {
              webSeen.push(new URL(req.url).pathname)
              return req.headers.get("x-key") === "k"
                ? undefined
                : new Response(null, { status: 401 })
            },
            onNodeRequest: (req) => {
              nodeSeen.push(req.url)
              return req.header("x-key") === "k" ? undefined : new Response(null, { status: 401 })
            },
          })
          .get("/x", () => {
            handled += 1
            return { ok: true }
          }),
      )
      .get("/open", () => ({ ok: true }))

    const denied = await app.resolveNode(new Request("http://x/api/x"))
    expect(denied.kind === "response" ? denied.response.status : denied.status).toBe(401)
    const open = await app.resolveNode(new Request("http://x/open"))
    expect(open.kind === "response" ? open.response.status : open.status).toBe(200)
    const allowed = await app.resolveNode(
      new Request("http://x/api/x", { headers: { "x-key": "k" } }),
    )
    expect(allowed.kind === "response" ? allowed.response.status : allowed.status).toBe(200)
    expect(handled).toBe(1)
    // Exactly one of the twins ran per request under the prefix; neither ran for /open.
    expect(webSeen.length + nodeSeen.length).toBe(2)
    expect([...webSeen, ...nodeSeen].every((url) => url.includes("/api/x"))).toBe(true)
  })

  test("group response hooks, static headers, and finalizers stay under the prefix", async () => {
    const finalized: string[] = []
    const app = server()
      .onResponse((response) => {
        response.headers.set("x-app", "1")
        return response
      })
      .group("/api", (api) =>
        api
          .responseHeaders({ "cache-control": "no-store", "x-group-static": "1" })
          .onResponse((response) => {
            response.headers.set("x-group", "1")
            return response
          })
          .onResponseFinalized((_outcome, req) => {
            finalized.push(new URL(req.url).pathname)
          })
          .get("/x", () => ({ ok: true }))
          .get("/cached", (c) => {
            c.set.headers["cache-control"] = "max-age=60"
            return { ok: true }
          }),
      )
      .get("/public", () => ({ ok: true }))

    const inside = await get(app, "/api/x")
    expect(inside.headers.get("x-group")).toBe("1")
    expect(inside.headers.get("x-group-static")).toBe("1")
    expect(inside.headers.get("cache-control")).toBe("no-store")
    expect(inside.headers.get("x-app")).toBe("1")
    // Static headers are defaults: a value the route set wins.
    expect((await get(app, "/api/cached")).headers.get("cache-control")).toBe("max-age=60")
    const missing = await get(app, "/api/nope")
    expect(missing.status).toBe(404)
    expect(missing.headers.get("x-group")).toBe("1")

    const outside = await get(app, "/public")
    expect(outside.headers.get("x-group")).toBeNull()
    expect(outside.headers.get("x-group-static")).toBeNull()
    expect(outside.headers.get("cache-control")).toBeNull()
    expect(outside.headers.get("x-app")).toBe("1")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(finalized).toEqual(["/api/x", "/api/cached", "/api/nope"])
  })

  test("a nested group's hooks run only under the nested prefix; the outer's cover both", async () => {
    const seen: string[] = []
    const app = server().group("/api", (api) =>
      api
        .onRequest((req) => {
          seen.push(`outer ${new URL(req.url).pathname}`)
          return undefined
        })
        .get("/a", () => "a")
        .group("/v1", (v1) =>
          v1
            .onRequest((req) => {
              seen.push(`inner ${new URL(req.url).pathname}`)
              return undefined
            })
            .get("/b", () => "b"),
        ),
    )
    await get(app, "/api/a")
    await get(app, "/api/v1/b")
    expect(seen).toEqual(["outer /api/a", "outer /api/v1/b", "inner /api/v1/b"])
  })

  test("the Node-direct response lane keeps group response hooks scoped", async () => {
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .group("/api", (api) =>
        api.responseHeaders({ "x-group-static": "1" }).get("/x", () => ({ ok: true })),
      )
      .get("/public", () => ({ ok: true }))
    const headerOf = async (path: string) => {
      const outcome = await app.resolveNode(new Request(`http://x${path}`))
      if (outcome.kind === "response") return outcome.response.headers.get("x-group-static")
      const value = outcome.headers?.["x-group-static"]
      return value === undefined ? null : String(value)
    }
    expect(await headerOf("/api/x")).toBe("1")
    expect(await headerOf("/public")).toBeNull()
  })
})

describe("group() - plugins", () => {
  test("a plugin applied in a group stays there; the parent can still apply it after", async () => {
    const seen: string[] = []
    const tagger = {
      name: "tagger",
      onRequest: (req: Request) => {
        seen.push(new URL(req.url).pathname)
        return undefined
      },
    }
    const app = server()
      .group("/g", (g) => g.use(tagger).get("/x", () => "x"))
      .use(tagger)
      .get("/y", () => "y")
    await get(app, "/g/x")
    await get(app, "/y")
    // The parent's copy runs for both; the group's copy only under /g.
    expect(seen).toEqual(["/g/x", "/g/x", "/y"])
  })

  test("a plugin the parent already applied is not re-applied inside the group", async () => {
    let runs = 0
    const counter = {
      name: "counter",
      onRequest: () => {
        runs += 1
        return undefined
      },
    }
    const app = server()
      .use(counter)
      .group("/g", (g) => g.use(counter).get("/x", () => "x"))
    await get(app, "/g/x")
    expect(runs).toBe(1)
  })

  test("responseObserver() applied on the parent can be applied again inside a group", async () => {
    const app = server()
      .use(responseObserver())
      .group("/g", (g) =>
        g
          .use(responseObserver())
          .onResponseHeaders((headers) => {
            headers.set("x-observed", "1")
          })
          .get("/x", () => ({ ok: true })),
      )
      .get("/y", () => ({ ok: true }))
    expect((await get(app, "/g/x")).headers.get("x-observed")).toBe("1")
    expect((await get(app, "/y")).headers.get("x-observed")).toBeNull()
  })
})

describe("group() - fail closed", () => {
  test("prefixes that are not static text are refused, naming the value", () => {
    const invalid: unknown[] = [
      "",
      "/",
      "api",
      "/api/",
      "/:id",
      "/api/:version",
      "/*",
      "/api/*",
      "//api",
      "/a//b",
      "/a/./b",
      "/a/../b",
      "/.",
      "/..",
      "/a%20b",
      "/a b",
      "/a?x=1",
      "/a#x",
      "/a:b",
      "/a\\b",
      "/a\nb",
      "/café",
      42,
      undefined,
      null,
    ]
    for (const prefix of invalid) {
      expect(() => server().group(prefix as string, (g) => g)).toThrow(RouteConfigError)
    }
    expect(() => server().group("/a b", (g) => g)).toThrow(/"\/a b"/)
    for (const prefix of ["/api", "/api/v1", "/a-b_c.d~e", "/v1.2", "/@scope", "/x,y;z=1"]) {
      expect(() => server().group(prefix, (g) => g)).not.toThrow()
    }
  })

  test("a route path without a leading slash is refused inside a group", () => {
    expect(() => server().group("/api", (g) => g.get("users", () => "u"))).toThrow(RouteConfigError)
    expect(() => server().group("/api", (g) => g.get("", () => "u"))).toThrow(RouteConfigError)
  })

  test("a collision adopts nothing: no route, no hook", async () => {
    const seen: string[] = []
    const app = server().get("/api/taken", () => ({ parent: true }))
    expect(() =>
      app.group("/api", (api) =>
        api
          .onRequest((req) => {
            seen.push(req.url)
            return undefined
          })
          .get("/added", () => ({ ghost: true }))
          .get("/taken", () => ({ shadowed: true })),
      ),
    ).toThrow(RouteConfigError)
    expect(routeKeys(app)).toEqual(["GET /api/taken"])
    expect((await get(app, "/api/added")).status).toBe(404)
    expect(await (await get(app, "/api/taken")).json()).toEqual({ parent: true })
    expect(seen).toEqual([])
  })

  test("the builder must synchronously return the scope it was given", async () => {
    const app = server()
    expect(() => app.group("/a", (() => server()) as never)).toThrow(
      /must return its group synchronously/,
    )
    expect(() => app.group("/b", (async (g: never) => g) as never)).toThrow(/synchronously/)
    expect(() => app.group("/c", "nope" as never)).toThrow(TypeError)
    expect(() =>
      app.group("/d", () => {
        throw new Error("builder failed")
      }),
    ).toThrow("builder failed")
    expect(routeKeys(app)).toEqual([])
  })

  test("a leaked or async-continued scope is closed once the builder returns", async () => {
    let leaked: { get(path: string, handler: () => unknown): unknown } | undefined
    const app = server().group("/api", (api) => {
      leaked = api as never
      return api.get("/x", () => "x")
    })
    let error: unknown
    try {
      leaked?.get("/late", () => "late")
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(FrameworkError)
    expect(String((error as Error).message)).toMatch(/a group once its builder returns/)
    expect(routeKeys(app)).toEqual(["GET /api/x"])

    let asyncScope: { get(path: string, handler: () => unknown): unknown } | undefined
    expect(() =>
      server().group("/b", (async (g: never) => {
        asyncScope = g
        return g
      }) as never),
    ).toThrow(/synchronously/)
    expect(() => asyncScope?.get("/x", () => "x")).toThrow(FrameworkError)
  })

  test("a builder that serves its scope with listen() is refused, and the scope is closed", async () => {
    let scope:
      | { stop(): Promise<void>; get(path: string, handler: () => unknown): unknown }
      | undefined
    const app = server()
    expect(() =>
      app.group("/api", (api) => {
        scope = api as never
        api.get("/x", () => "x").listen(0, { hostname: "127.0.0.1" })
        return api
      }),
    ).toThrow(/must return its group synchronously/)
    await scope?.stop()
    expect(routeKeys(app)).toEqual([])
    expect(() => scope?.get("/y", () => "y")).toThrow(FrameworkError)
  })

  test("a throwing builder's scope is closed too", () => {
    let leaked: { get(path: string, handler: () => unknown): unknown } | undefined
    expect(() =>
      server().group("/api", (api) => {
        leaked = api as never
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(() => leaked?.get("/x", () => "x")).toThrow(FrameworkError)
  })

  test("ws routes, mounts, MCP tools, and merge() are refused inside a group", () => {
    expect(() =>
      server()
        .use(websocket())
        .group("/rt", (rt) => rt.ws("/live", { message: () => {} })),
    ).toThrow(/cannot hold ws\(\), mount, or MCP tool routes/)
    expect(() =>
      server().group("/legacy", (legacy) => legacy.mountFetch("/old", () => new Response("old"))),
    ).toThrow(/cannot hold ws\(\), mount, or MCP tool routes/)
    expect(() =>
      server()
        .use(mcp())
        .group("/agents", (agents) =>
          agents.tool(
            "echo",
            { description: "echo", input: t.object({ v: t.string() }) },
            (input) => input,
          ),
        ),
    ).toThrow(/cannot hold ws\(\), mount, or MCP tool routes/)
    const other = server().get("/x", () => "x")
    expect(() => server().group("/api", (api) => api.merge(other))).toThrow(RouteConfigError)
  })

  test("the unused-scoped-hook audit covers a group's own chain", () => {
    expect(() =>
      server({ unusedScopedHooks: "error" }).group("/api", (api) =>
        api.get("/x", () => "x").beforeHandle(() => undefined),
      ),
    ).toThrow(/order-scoped hook/)
    // A parent hook placed before the group covers the group's routes - not dead.
    expect(() =>
      server({ unusedScopedHooks: "error" })
        .beforeHandle(() => undefined)
        .group("/api", (api) => api.get("/x", () => "x")),
    ).not.toThrow()
  })
})

describe("merge()/group() - stop hooks", () => {
  test("onStop cleanup registered in a merged server or a group runs on the parent's stop()", async () => {
    const events: string[] = []
    const merged = server()
      .onStop(() => {
        events.push("merged")
      })
      .get("/m", () => "m")
    const app = server()
      .merge(merged)
      .group("/g", (g) =>
        g
          .onStop(() => {
            events.push("group")
          })
          .get("/x", () => "x"),
      )
    ;(app as unknown as { bunServer: { pendingRequests: number; stop(): void } }).bunServer = {
      pendingRequests: 0,
      stop() {},
    }
    await app.stop()
    expect(events.sort()).toEqual(["group", "merged"])
  })
})
