import { describe, expect, test } from "bun:test"
import {
  authenticated,
  echoParam,
  rejected,
  type ServerOptions,
  server,
  staticResponse,
} from "../src/index.ts"
import {
  declarativeRoutes,
  isServerView,
  type ServerView,
  transportMayAnswer,
} from "../src/server/declarative-routes.ts"
import { Server } from "../src/server/server.ts"
import { websocket } from "../src/ws.ts"

type NativeFallback = (request: Request, server: object) => Response
type Table = Record<string, Record<string, unknown>> | undefined

/** Whether Bun's table holds `GET /health` as a fixed value. */
function bunServesFixed(app: object): boolean {
  const fallback: NativeFallback = () => new Response(null)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: this test inspects the private Bun route-table compiler.
  const build = app as {
    buildBunNativeRoutes(fallback: NativeFallback, peer: object, platformFor: () => object): Table
  }
  return build.buildBunNativeRoutes(fallback, {}, () => ({}))?.["/health"]?.GET instanceof Response
}

function viewOf(app: object): ServerView {
  if (!isServerView(app)) throw new Error("not a server")
  return app
}

function uwsServesFixed(app: object): boolean {
  return declarativeRoutes(viewOf(app)).some(
    (route) => route.method === "GET" && route.path === "/health",
  )
}

const fixed = staticResponse({ headers: { "x-fixed": "1" } })

/** Everything a route can sit behind, as the app that holds it before the route is added. */
const setups: Array<[string, () => object, boolean]> = [
  ["a plain app", () => server(), true],
  ["onRequest", () => server().onRequest(() => {}), false],
  ["onResponse", () => server().onResponse((response) => response), false],
  ["onResponseFinalized", () => server().onResponseFinalized(() => {}), false],
  ["responseHeaders", () => server().responseHeaders({ "x-policy": "1" }), false],
  ["beforeHandle", () => server().beforeHandle(() => {}), false],
  ["afterHandle", () => server().afterHandle(() => {}), false],
  ["onError", () => server().onError(() => {}), false],
  ["derive", () => server().derive(() => ({ a: 1 })), false],
  ["decorate", () => server().decorate("a", 1), false],
  [
    "authenticate",
    () =>
      server().authenticate({
        id: "token",
        mode: "sync",
        run: () => (Math.random() > 2 ? authenticated({ id: "u" }) : rejected("unauthenticated")),
      }),
    false,
  ],
  ["validateHost", () => server({ validateHost: true }), false],
  ["normalizeTarget", () => server({ normalizeTarget: true }), false],
  ["requestTimeoutMs", () => server({ requestTimeoutMs: 100 }), false],
  ["acceptInboundDeadlines", () => server({ acceptInboundDeadlines: true }), false],
  [
    "admission",
    () =>
      server({
        admission: {
          admit: () => ({ admitted: false, response: new Response(null, { status: 429 }) }),
        },
      } satisfies ServerOptions),
    false,
  ],
]

/** `app.get(path, handler)` without the route registry's types, for handlers the types would refuse. */
function routeOf(app: object, path: string, handler: unknown): object {
  return Reflect.apply(Reflect.get(app, "get"), app, [path, handler])
}

/** A route as the fixed-reply path sees it, and the pattern it is listed under. */
const fixedRoute = (app: object): object => routeOf(app, "/health", fixed)

describe("fixed-reply routes: uWS and Bun agree on every disqualifier", () => {
  for (const [name, setup, expected] of setups) {
    test(name, () => {
      expect(bunServesFixed(fixedRoute(setup()))).toBe(expected)
      expect(uwsServesFixed(fixedRoute(setup()))).toBe(expected)
    })
  }

  test("a handler that is not fixed", () => {
    const app = server().get("/health", () => "x")
    expect(bunServesFixed(app)).toBe(false)
    expect(uwsServesFixed(app)).toBe(false)
  })

  test("a 204", () => {
    const app = server().get("/health", staticResponse({ status: 204 }))
    expect(bunServesFixed(app)).toBe(false)
    expect(uwsServesFixed(app)).toBe(false)
  })

  test("the app-level gate reads the same fields in both places", () => {
    const fields = [...transportMayAnswer.toString().matchAll(/server\.(\w+)/g)].map((m) => m[1])
    const bun = String(Reflect.get(Server.prototype, "buildBunNativeRoutes"))
    expect(fields.length).toBeGreaterThanOrEqual(10)
    for (const field of fields) expect(bun).toContain(`this.${field}`)
  })
})

describe("echoParam routes follow the same app-level disqualifiers", () => {
  for (const [name, setup, expected] of setups) {
    test(name, () => {
      const app = routeOf(setup(), "/user/:id", echoParam("id"))
      expect(declarativeRoutes(viewOf(app)).length).toBe(expected ? 1 : 0)
    })
  }

  test("lists the parameter with the text headers", () => {
    const app = server().get("/user/:id", echoParam("id"))
    expect(declarativeRoutes(viewOf(app))).toEqual([
      {
        method: "GET",
        path: "/user/:id",
        status: 200,
        headers: [
          ["content-type", "text/plain; charset=utf-8"],
          ["x-content-type-options", "nosniff"],
        ],
        param: "id",
      },
    ])
  })

  test("only a route whose single parameter is its last segment is listed", () => {
    const typed = server()
      .get("/a/:id/x", echoParam("id"))
      .get("/b/:one/:id", echoParam("id"))
      .get("/d/:id", () => "not an echo")
      .get("/:id", echoParam("id"))
      .post("/e/:id", echoParam("id"))
    // The name does not match the route's parameter: the types refuse it.
    const app = routeOf(typed, "/c/:id", echoParam("other"))
    expect(declarativeRoutes(viewOf(app)).map((route) => route.path)).toEqual(["/:id"])
  })

  test("a route with a schema of its own is not listed", () => {
    const anything = {
      "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
    } as const
    const app = server()
      .get("/schema/:id", { query: anything }, echoParam("id"))
      .get("/plain/:id", echoParam("id"))
    expect(declarativeRoutes(viewOf(app)).map((route) => route.path)).toEqual(["/plain/:id"])
  })

  test("an echo route yields to every route that may take a request it would answer", () => {
    const anything = server().get("/", () => "x")
    const cases: Array<[string, object]> = [
      [
        "a more specific GET",
        server()
          .get("/user/:id", echoParam("id"))
          .get("/user/me", () => "me"),
      ],
      [
        "a more specific route of another method",
        server()
          .get("/user/:id", echoParam("id"))
          .post("/user/me", () => "me"),
      ],
      [
        "a part-literal route",
        server()
          .get("/user/:id", echoParam("id"))
          .get("/user/:id.json", () => "j"),
      ],
      [
        "a catch-all",
        server()
          .get("/user/:id", echoParam("id"))
          .get("/user/*", () => "all"),
      ],
      [
        "a mount ahead of the routes",
        server().mount({ path: "/user/me", app: anything }).get("/user/:id", echoParam("id")),
      ],
    ]
    for (const [name, app] of cases) {
      expect(
        declarativeRoutes(viewOf(app)).map((route) => route.path),
        name,
      ).toEqual([])
    }
  })

  test("an echo route is listed beside routes that cannot take its requests", () => {
    const app = server()
      .get("/user/:id", echoParam("id"))
      .post("/user/:id", () => "same pattern, another method")
      .get("/user", () => "shorter")
      .get("/user/:id/posts", () => "longer")
      .get("/other/me", () => "elsewhere")
    expect(declarativeRoutes(viewOf(app)).map((route) => route.path)).toEqual(["/user/:id"])
  })

  test("the marker the module reads is the one echoParam sets", () => {
    expect(Reflect.get(echoParam("id"), Symbol.for("@nifrajs/core/echo-param"))).toBe("id")
    expect(() => echoParam("not a name")).toThrow(TypeError)
  })

  test("answers the raw segment, and the decoded value where the raw one cannot be told", async () => {
    const app = server().get("/user/:id", echoParam("id")).get("/p/:q/x", echoParam("q"))
    const body = async (path: string) => {
      const response = await app.fetch(new Request(`http://nifra.test${path}`))
      return [response.status, await response.text(), response.headers.get("content-type")]
    }
    expect(await body("/user/abc")).toEqual([200, "abc", "text/plain; charset=utf-8"])
    expect(await body("/user/%41bc?x=1")).toEqual([200, "%41bc", "text/plain; charset=utf-8"])
    expect(await body("/user/a%2Fb")).toEqual([200, "a%2Fb", "text/plain; charset=utf-8"])
    expect(await body("/user/caf%C3%A9")).toEqual([200, "caf%C3%A9", "text/plain; charset=utf-8"])
    // The parameter is not the last segment: the decoded value.
    expect(await body("/p/%41/x")).toEqual([200, "A", "text/plain; charset=utf-8"])
    // Nor is it the route's last parameter when the final segment decodes to the same value.
    const both = server().get("/q/:id/:tail", echoParam("id"))
    const answer = await both.fetch(new Request("http://nifra.test/q/A/%41"))
    expect(await answer.text()).toBe("A")
  })
})

describe("declarativeRoutes", () => {
  test("lists GET fixed routes with their status and headers; a POST stays with the router", () => {
    const app = server()
      .get("/", staticResponse())
      .get("/created", staticResponse({ status: 201, headers: { "x-a": "1" } }))
      .post("/user", staticResponse())
      .put("/user", staticResponse())
    expect(declarativeRoutes(viewOf(app))).toEqual([
      { method: "GET", path: "/", status: 200, headers: [] },
      { method: "GET", path: "/created", status: 201, headers: [["x-a", "1"]] },
    ])
  })

  test("a fixed route stays listed beside a less specific one", () => {
    const app = server()
      .get("/ping", fixed)
      .get("/:anything", () => "x")
    expect(declarativeRoutes(viewOf(app)).map((route) => route.path)).toEqual(["/ping"])
  })

  test("seals the server, as listen() does", () => {
    const app = server().get("/", staticResponse())
    declarativeRoutes(viewOf(app))
    expect(() => app.get("/late", () => "late")).toThrow(/sealed/)
  })

  test("leaves a path a transport would read as a pattern or the router would decode", () => {
    const app = server().get("/a%20b", fixed).get("/ok", fixed)
    expect(declarativeRoutes(viewOf(app)).map((route) => route.path)).toEqual(["/ok"])
  })

  test("leaves a path under a mount that runs before the routes", () => {
    const app = server()
      .mount({ path: "/api", app: server().get("/x", () => "mounted") })
      .get("/api/health", fixed)
      .get("/other", fixed)
    expect(declarativeRoutes(viewOf(app)).map((route) => route.path)).toEqual(["/other"])
  })

  test("leaves a GET path a WebSocket route may take", () => {
    const app = server()
      .use(websocket())
      .ws("/live/:room", { message: () => {} })
      .get("/live/lobby", fixed)
      .get("/plain", fixed)
    expect(declarativeRoutes(viewOf(app)).map((route) => route.path)).toEqual(["/plain"])
  })

  test("a value that is not a nifra server is not a view", () => {
    expect(isServerView({ fetch: () => new Response() })).toBe(false)
  })

  test("a real server satisfies every field the view names", () => {
    const view: ServerView = (() => {
      const app = server()
      if (!isServerView(app)) throw new Error("not a server")
      return app
    })()
    for (const key of [
      "sealed",
      "validateHost",
      "normalizeTarget",
      "requestTimeoutMs",
      "acceptInboundDeadlines",
      "capacityGate",
      "onRequestHooks",
      "onResponseHooks",
      "onResponseFinalizedHooks",
      "staticResponseHeaders",
      "responseBodyTag",
      "catalog",
      "wsRoutes",
      "fetchMounts",
    ]) {
      expect(key in view).toBe(true)
    }
  })
})
