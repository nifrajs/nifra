import { afterEach, describe, expect, test } from "bun:test"
import {
  type AnyServer,
  authenticated,
  type RunningServer,
  rejected,
  server,
  status,
  toFetchHandler,
  type WebSocketUpgradeOutcome,
} from "../src/index.ts"
import { websocket } from "../src/ws.ts"
import { INVALID_HOSTS, REPEATED_HOSTS, rawUpgradeStatus } from "./request-target-matrix.ts"

/**
 * A WebSocket handshake is a `GET`, so it runs the chain an HTTP `GET` registered at the same point
 * runs: the `authenticate()` stages, derives and beforeHandles before the route, then `upgrade()`.
 * Each guard below sits in front of an HTTP route and a socket registered together; whatever the
 * HTTP route answers, the handshake answers the same, and a socket opens only where the HTTP route
 * would have run its handler.
 */

const GOOD = "Bearer good"

let running: RunningServer | undefined
afterEach(() => {
  running?.stop(true)
  running = undefined
})

const handshake = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`http://t${path}`, { headers: { upgrade: "websocket", ...headers } })

const resolve = async (
  app: AnyServer,
  path: string,
  headers: Record<string, string> = {},
): Promise<WebSocketUpgradeOutcome> => {
  const upgradeOf = app.resolveWebSocketUpgrade
  if (upgradeOf === undefined) throw new Error("the server takes no upgrades")
  return await upgradeOf.call(app, handshake(path, headers))
}

const statusOf = (outcome: WebSocketUpgradeOutcome): number | "upgrade" | "pass" =>
  outcome.kind === "reject" ? outcome.response.status : outcome.kind

const dataOf = (outcome: WebSocketUpgradeOutcome): unknown =>
  outcome.kind === "upgrade" ? outcome.data : undefined

type Guarded = (app: ReturnType<typeof base>) => AnyServer

const base = () => server().use(websocket())

const GUARDS: ReadonlyArray<readonly [string, Guarded]> = [
  [
    "authenticate()",
    (app) =>
      app
        .authenticate({
          id: "test-auth",
          mode: "sync",
          run: (input) =>
            input.headers.get("authorization") === GOOD
              ? authenticated({ userId: "u1" })
              : rejected(),
        })
        .get("/http", (c) => ({ user: c.principal.userId }))
        .ws("/socket", { upgrade: (c) => ({ user: c.principal.userId }) }),
  ],
  [
    "a beforeHandle guard",
    (app) =>
      app
        .beforeHandle((c) =>
          c.req.headers.get("authorization") === GOOD ? undefined : status(401, { error: "no" }),
        )
        .get("/http", () => ({ user: "u1" }))
        .ws("/socket", { upgrade: () => ({ user: "u1" }) }),
  ],
  [
    "a derive guard",
    (app) =>
      app
        .derive((c) =>
          c.req.headers.get("authorization") === GOOD
            ? { user: "u1" }
            : status(401, { error: "no" }),
        )
        .get("/http", (c) => ({ user: c.user }))
        .ws("/socket", { upgrade: (c) => ({ user: c.user }) }),
  ],
  [
    "an async derive guard",
    (app) =>
      app
        .derive(async (c) => {
          await Promise.resolve()
          if (c.req.headers.get("authorization") !== GOOD) throw new Response("no", { status: 401 })
          return { user: "u1" }
        })
        .get("/http", (c) => ({ user: c.user }))
        .ws("/socket", { upgrade: (c) => ({ user: c.user }) }),
  ],
]

describe("a WebSocket handshake runs the route chain an HTTP GET runs", () => {
  for (const [name, guard] of GUARDS) {
    test(`${name}: refused exactly where the HTTP route is, opened with the identity it derives`, async () => {
      const app = guard(base())
      const http = await app.fetch(new Request("http://t/http"))
      const refused = await resolve(app, "/socket")
      expect(http.status).toBe(401)
      expect(statusOf(refused)).toBe(401)

      const allowed = await resolve(app, "/socket", { authorization: GOOD })
      const httpAllowed = await app.fetch(
        new Request("http://t/http", { headers: { authorization: GOOD } }),
      )
      expect(httpAllowed.status).toBe(200)
      expect(statusOf(allowed)).toBe("upgrade")
      expect(dataOf(allowed)).toEqual({ user: "u1" })
    })
  }

  test("a socket registered before the guard stays public, like an HTTP route there", async () => {
    const app = base()
      .ws("/before", {})
      .get("/before-http", () => "ok")
      .beforeHandle(() => status(401, { error: "no" }))
      .ws("/after", {})
    expect(statusOf(await resolve(app, "/before"))).toBe("upgrade")
    expect((await app.fetch(new Request("http://t/before-http"))).status).toBe(200)
    expect(statusOf(await resolve(app, "/after"))).toBe(401)
  })

  test("a socket with no chain and no upgrade() opens with no data", async () => {
    const app = base().ws("/open", {})
    const outcome = await resolve(app, "/open")
    expect(statusOf(outcome)).toBe("upgrade")
    expect(dataOf(outcome)).toBeUndefined()
  })

  test("the origin check refuses a cross-site handshake before any guard runs", async () => {
    let ran = 0
    const app = base()
      .derive(() => {
        ran += 1
        return { user: "u1" }
      })
      .ws("/default", {})
      .ws("/listed", { allowedOrigins: ["https://ok.test"] })
    const crossSite = { origin: "https://evil.test", authorization: GOOD }
    expect(statusOf(await resolve(app, "/default", crossSite))).toBe(403)
    expect(statusOf(await resolve(app, "/listed", crossSite))).toBe(403)
    expect(ran).toBe(0)
    expect(statusOf(await resolve(app, "/listed", { origin: "https://ok.test" }))).toBe("upgrade")
    expect(ran).toBe(1)
  })

  test("every refused handshake carries the app's static response headers", async () => {
    const child = base().ws("/live", {})
    const app = server()
      .responseHeaders({ "x-frame-options": "DENY" })
      .use(websocket())
      .onRequest((req) =>
        req.headers.has("x-block") ? new Response("no", { status: 429 }) : undefined,
      )
      .beforeHandle(() => status(401, { error: "no" }))
      .ws("/socket", {})
      .mount({ path: "/m", app: child, stripPrefix: true })
    const refused = async (path: string, headers: Record<string, string>) => {
      const outcome = await resolve(app, path, headers)
      if (outcome.kind !== "reject") throw new Error(`expected a rejection, got ${outcome.kind}`)
      return [outcome.response.status, outcome.response.headers.get("x-frame-options")]
    }
    expect(await refused("/socket", { origin: "https://evil.test" })).toEqual([403, "DENY"])
    expect(await refused("/socket", { "x-block": "1" })).toEqual([429, "DENY"])
    expect(await refused("/socket", {})).toEqual([401, "DENY"])
    expect(await refused("/m/live", { origin: "https://evil.test" })).toEqual([403, "DENY"])
  })

  test("a guard's rejection carries the cookies and status it set, rendered as HTTP renders it", async () => {
    const app = base()
      .derive((c) => {
        c.set.cookie("sid", "", { maxAge: 0 })
        return status(401, { error: "session_expired" })
      })
      .get("/http", () => "ok")
      .ws("/socket", {})
    const outcome = await resolve(app, "/socket")
    const http = await app.fetch(new Request("http://t/http"))
    if (outcome.kind !== "reject") throw new Error(`expected a rejection, got ${outcome.kind}`)
    expect(outcome.response.status).toBe(401)
    expect(outcome.response.headers.getSetCookie()).toEqual(http.headers.getSetCookie())
    expect(await outcome.response.json()).toEqual(await http.json())
  })

  test("upgrade() may reject with status(...) or a thrown Response, and sees the decorations", async () => {
    const app = base()
      .decorate("realm", "chat")
      .ws("/status", { upgrade: () => status(403, { error: "full" }) })
      .ws("/thrown", {
        upgrade: () => {
          throw new Response("gone", { status: 410 })
        },
      })
      .ws("/decorated", { upgrade: (c) => ({ realm: c.realm }) })
    expect(statusOf(await resolve(app, "/status"))).toBe(403)
    expect(statusOf(await resolve(app, "/thrown"))).toBe(410)
    expect(dataOf(await resolve(app, "/decorated"))).toEqual({ realm: "chat" })
  })

  test("an error thrown in the chain goes to the route's onError hooks, else a flat 500", async () => {
    const app = base()
      .ws("/plain", {
        upgrade: () => {
          throw new Error("boom")
        },
      })
      .onError(() => status(503, { error: "try_later" }))
      .ws("/handled", {
        upgrade: () => {
          throw new Error("boom")
        },
      })
    const plain = await resolve(app, "/plain")
    expect(statusOf(plain)).toBe(500)
    if (plain.kind === "reject") {
      expect(await plain.response.json()).toEqual({ ok: false, error: "internal_error" })
    }
    expect(statusOf(await resolve(app, "/handled"))).toBe(503)
  })

  test("the upgrade timeout bounds a slow guard", async () => {
    let release: (() => void) | undefined
    const app = server({ wsUpgradeTimeoutMs: 20 })
      .use(websocket())
      .derive(
        () =>
          new Promise<{ user: string }>((done) => {
            release = () => done({ user: "late" })
          }),
      )
      .ws("/slow", {})
    const outcome = await resolve(app, "/slow")
    release?.()
    expect(statusOf(outcome)).toBe(503)
  })

  test("a socket served by listen() answers a handshake without credentials with 401", async () => {
    const app = base()
      .beforeHandle((c) =>
        c.req.headers.get("authorization") === GOOD ? undefined : status(401, { error: "no" }),
      )
      .ws("/socket", {})
    running = app.listen(0, { hostname: "127.0.0.1" })
    expect(await rawUpgradeStatus(running.port, "/socket")).toBe(401)
    expect(await rawUpgradeStatus(running.port, "/socket", { authorization: GOOD })).toBe(101)
  })

  test("a handshake with a Host no URL can be built on is refused, as HTTP refuses it", async () => {
    // Bun hands such a request over with its target unparsed; `upgrade()` would read a URL the app
    // cannot parse.
    const app = base().ws("/socket", { upgrade: (c) => ({ path: new URL(c.req.url).pathname }) })
    running = app.listen(0, { hostname: "127.0.0.1" })
    for (const host of INVALID_HOSTS) {
      expect({ host, status: await rawUpgradeStatus(running.port, "/socket", {}, host) }).toEqual({
        host,
        status: 400,
      })
    }
    expect(await rawUpgradeStatus(running.port, "/socket")).toBe(101)
  })

  test("a handshake with two Host fields is refused, as HTTP refuses it", async () => {
    // Bun routes on the first Host while `upgrade()` would read both from the header.
    const app = base().ws("/socket", { upgrade: (c) => ({ host: c.req.headers.get("host") }) })
    running = app.listen(0, { hostname: "127.0.0.1" })
    const statuses: unknown[] = []
    for (const hosts of REPEATED_HOSTS) {
      statuses.push([hosts, await rawUpgradeStatus(running.port, "/socket", {}, hosts)])
    }
    expect(statuses).toEqual(REPEATED_HOSTS.map((hosts) => [hosts, 400]))
    expect(await rawUpgradeStatus(running.port, "/socket")).toBe(101)
  })

  test("toFetchHandler on Workers answers a handshake without credentials with 401", async () => {
    const app = base()
      .beforeHandle((c) =>
        c.req.headers.get("authorization") === GOOD ? undefined : status(401, { error: "no" }),
      )
      .ws("/socket", {})
    const handler = toFetchHandler(app)
    const accepted: unknown[] = []
    const original: unknown = Reflect.get(globalThis, "WebSocketPair")
    Reflect.set(
      globalThis,
      "WebSocketPair",
      class {
        readonly 0 = {}
        readonly 1 = {
          readyState: 1,
          accept: () => accepted.push(true),
          send: () => {},
          close: () => {},
          addEventListener: () => {},
        }
      },
    )
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
    try {
      const refused = await handler.fetch(handshake("/socket"), {}, ctx)
      expect(refused.status).toBe(401)
      expect(accepted).toEqual([])
    } finally {
      Reflect.set(globalThis, "WebSocketPair", original)
    }
  })

  test("a mounted child's socket runs the child's chain", async () => {
    const child = base()
      .beforeHandle((c) =>
        c.req.headers.get("authorization") === GOOD ? undefined : status(401, { error: "no" }),
      )
      .ws("/socket", {})
    const app = server().mount({ path: "/child", app: child, stripPrefix: true })
    expect(statusOf(await resolve(app, "/child/socket"))).toBe(401)
    expect(statusOf(await resolve(app, "/child/socket", { authorization: GOOD }))).toBe("upgrade")
  })
})
