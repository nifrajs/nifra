import { describe, expect, test } from "bun:test"
import {
  type AuthenticationStage,
  authenticated,
  isAuthenticatedRequest,
  type Logger,
  rejected,
  server,
  status,
  type WebSocketUpgradeOutcome,
} from "../src/index.ts"
import { NODE_NATIVE_MOUNT, RESOLVE_NODE_MOUNT } from "../src/server/install.ts"
import { attachWebSocket, TopicRegistry } from "../src/ws.ts"

const token: AuthenticationStage<{ readonly id: string }> = {
  id: "token",
  mode: "sync",
  run: (input) =>
    input.headers.get("authorization") === "Bearer ok"
      ? authenticated({ id: "u1" })
      : rejected("unauthenticated"),
}

const legacy = (request: Request): Response =>
  new Response(`legacy ${new URL(request.url).pathname}`)

const ask = async (
  app: { fetch(request: Request): Response | Promise<Response> },
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<readonly [number, string]> => {
  const response = await app.fetch(new Request(`http://test${path}`, { method, headers }))
  return [response.status, await response.text()]
}

const SIGNED_IN = { authorization: "Bearer ok" }

describe("authenticate() stages gate the mounts registered after them", () => {
  test("mountFetch() refuses every method without credentials and serves them with credentials", async () => {
    const app = server()
      .authenticate(token)
      .mountFetch("/legacy", legacy)
      .get("/route", () => "route")
    for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) {
      expect((await ask(app, "/legacy/a", {}, method))[0]).toBe(401)
    }
    expect(await ask(app, "/legacy/a", SIGNED_IN)).toEqual([200, "legacy /legacy/a"])
    expect((await ask(app, "/route"))[0]).toBe(401)
  })

  test("a mount() child is gated the same way, before its own lifecycle runs", async () => {
    let childRuns = 0
    const child = server()
      .onRequest(() => {
        childRuns++
      })
      .get("/hello", () => "child")
    const app = server()
      .authenticate(token)
      .mount({ path: "/child", app: child, stripPrefix: true })
    expect((await ask(app, "/child/hello"))[0]).toBe(401)
    expect(childRuns).toBe(0)
    expect(await ask(app, "/child/hello", SIGNED_IN)).toEqual([200, '"child"'])
  })

  test("a mount registered before the stage stays public", async () => {
    const app = server()
      .mountFetch("/public", legacy)
      .authenticate(token)
      .mountFetch("/private", legacy)
    expect(await ask(app, "/public/a")).toEqual([200, "legacy /public/a"])
    expect((await ask(app, "/private/a"))[0]).toBe(401)
  })

  test("the mount sees an authenticated request; a stage's refusal and reason reach the client", async () => {
    let seen: boolean | undefined
    const app = server()
      .authenticate({
        id: "role",
        mode: "async",
        run: async (input) =>
          input.headers.get("x-role") === "admin"
            ? authenticated({ role: "admin" })
            : input.headers.get("x-role") === "guest"
              ? rejected("forbidden")
              : rejected("unauthenticated", status(401, { ok: false, error: "sign_in" })),
      })
      .mountFetch("/admin", (request) => {
        seen = isAuthenticatedRequest(request)
        return new Response("admin")
      })
    expect(await ask(app, "/admin")).toEqual([401, '{"ok":false,"error":"sign_in"}'])
    expect(await ask(app, "/admin", { "x-role": "guest" })).toEqual([
      403,
      '{"ok":false,"error":"forbidden"}',
    ])
    expect(await ask(app, "/admin", { "x-role": "admin" })).toEqual([200, "admin"])
    expect(seen).toBe(true)
  })

  test("a stage that throws or decides nothing answers 503 and logs why, never reaching the mount", async () => {
    const logged: string[] = []
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message) => {
        logged.push(message)
      },
    }
    let reached = 0
    const reach = (): Response => {
      reached++
      return new Response("reached")
    }
    const throwing = server({ logger })
      .authenticate({
        id: "broken",
        mode: "sync",
        run: () => {
          throw new Error("store down")
        },
      })
      .mountFetch("/m", reach)
    // JSON.parse types the decision loosely, so the stage can return a malformed one.
    const invalid: AuthenticationStage<unknown> = {
      id: "invalid",
      mode: "sync",
      run: () => JSON.parse("{}"),
    }
    const deciding = server({ logger }).authenticate(invalid).mountFetch("/m", reach)
    expect(await ask(throwing, "/m")).toEqual([503, '{"ok":false,"error":"auth_unavailable"}'])
    expect(await ask(deciding, "/m")).toEqual([503, '{"ok":false,"error":"auth_unavailable"}'])
    expect(reached).toBe(0)
    expect(logged).toEqual([
      "authenticate() stage failed before a mount",
      "authenticate() stage failed before a mount",
    ])
  })

  test("a stage sees the mount request's path, search and query", async () => {
    const seen: unknown[] = []
    const app = server()
      .authenticate({
        id: "query-key",
        mode: "sync",
        run: (input) => {
          seen.push([input.pathname, input.search, input.query])
          return input.query.key === "ok" ? authenticated({ id: "k" }) : rejected("unauthenticated")
        },
      })
      .mountFetch("/legacy", legacy)
    expect((await ask(app, "/legacy/a?key=no"))[0]).toBe(401)
    expect(await ask(app, "/legacy/a?key=ok&tag=1&tag=2")).toEqual([200, "legacy /legacy/a"])
    expect(seen).toEqual([
      ["/legacy/a", "?key=no", { key: "no" }],
      ["/legacy/a", "?key=ok&tag=1&tag=2", { key: "ok", tag: ["1", "2"] }],
    ])
  })

  test("each mount in a 404 fallthrough chain runs the stages it was registered after", async () => {
    const app = server()
      .mountFetch("/docs", () => new Response("missing", { status: 404 }), { fallbackOn: 404 })
      .authenticate(token)
      .mountFetch("/docs", legacy)
    expect((await ask(app, "/docs/a"))[0]).toBe(401)
    expect(await ask(app, "/docs/a", SIGNED_IN)).toEqual([200, "legacy /docs/a"])
  })

  test("a gated mount never takes the Node native lane", () => {
    const native = Object.assign(legacy, { [NODE_NATIVE_MOUNT]: () => {} })
    const open = server().mountFetch("/legacy", native)
    const gated = server().authenticate(token).mountFetch("/legacy", native)
    const request = new Request("http://test/legacy/a")
    expect(open[RESOLVE_NODE_MOUNT](request)).toBeDefined()
    expect(gated[RESOLVE_NODE_MOUNT](request)).toBeUndefined()
  })

  test("a gated mount() refuses a WebSocket upgrade without credentials", async () => {
    const child = {
      fetch: () => new Response("http"),
      resolveWebSocketUpgrade: (): WebSocketUpgradeOutcome => ({
        kind: "upgrade",
        handler: {},
        data: undefined,
        pubsub: new TopicRegistry(),
        attach: attachWebSocket,
      }),
    }
    const app = server().authenticate(token).mount({ path: "/ws", app: child })
    const upgrade = (headers: Record<string, string>) =>
      app.resolveWebSocketUpgrade(
        new Request("http://test/ws/chat", {
          headers: {
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
            ...headers,
          },
        }),
      )
    const refused = await upgrade({})
    expect(refused.kind).toBe("reject")
    expect(refused.kind === "reject" ? refused.response.status : 0).toBe(401)
    expect((await upgrade(SIGNED_IN)).kind).toBe("upgrade")
  })
  for (const mode of ["sync", "async"] as const) {
    const gate: AuthenticationStage<{ id: string }> = {
      id: "hidden",
      mode,
      run: (input) => {
        const decision = input.headers.has("x-session")
          ? authenticated({ id: "user" })
          : rejected("forbidden", new Response("hidden", { status: 404 }))
        return mode === "async" ? Promise.resolve(decision) : decision
      },
    }

    test(`${mode} auth 404 is terminal for HTTP, but authenticated child 404 falls through`, async () => {
      let childRuns = 0
      let fallbackRuns = 0
      const app = server()
        .mountFetch("/", () => {
          fallbackRuns++
          return new Response("fallback")
        })
        .authenticate(gate)
        .mountFetch(
          "/private",
          () => {
            childRuns++
            return new Response("child miss", { status: 404 })
          },
          { fallbackOn: 404 },
        )
      expect(await ask(app, "/private/a")).toEqual([404, "hidden"])
      expect([childRuns, fallbackRuns]).toEqual([0, 0])
      expect(await ask(app, "/private/a", { "x-session": "alice" })).toEqual([200, "fallback"])
      expect([childRuns, fallbackRuns]).toEqual([1, 1])
    })

    test(`${mode} auth 404 is terminal for WebSockets, but child rejection can fall through`, async () => {
      let childRuns = 0
      let fallbackRuns = 0
      const app = server()
        .mount({
          path: "/",
          app: {
            fetch: () => new Response("fallback"),
            resolveWebSocketUpgrade: (): WebSocketUpgradeOutcome => {
              fallbackRuns++
              return { kind: "reject", response: new Response("fallback", { status: 403 }) }
            },
          },
        })
        .authenticate(gate)
        .mount({
          path: "/private",
          fallbackOn: 404,
          app: {
            fetch: () => new Response("http"),
            resolveWebSocketUpgrade: (): WebSocketUpgradeOutcome => {
              childRuns++
              return { kind: "reject", response: new Response("child miss", { status: 404 }) }
            },
          },
        })
      for (const signedIn of [false, true]) {
        const headers = new Headers({ upgrade: "websocket" })
        if (signedIn) headers.set("x-session", "alice")
        const outcome = await app.resolveWebSocketUpgrade(
          new Request("http://test/private/a", {
            headers,
          }),
        )
        expect(outcome.kind).toBe("reject")
        if (outcome.kind === "reject") {
          expect(outcome.response.status).toBe(signedIn ? 403 : 404)
          expect(await outcome.response.text()).toBe(signedIn ? "fallback" : "hidden")
        }
        expect([childRuns, fallbackRuns]).toEqual(signedIn ? [1, 1] : [0, 0])
      }
    })
    test(`${mode} HTTP recheck after a WebSocket pass cannot fall through on auth denial`, async () => {
      let checks = 0
      let httpRuns = 0
      const app = server()
        .mountFetch("/", () => {
          httpRuns++
          return new Response("public fallback")
        })
        .authenticate({
          id: "recheck",
          mode,
          run: () => {
            const decision =
              ++checks === 1
                ? authenticated({ id: "alice" })
                : rejected("forbidden", new Response("hidden", { status: 404 }))
            return mode === "async" ? Promise.resolve(decision) : decision
          },
        })
        .mount({
          path: "/private",
          stripPrefix: true,
          fallbackOn: 404,
          app: {
            resolveWebSocketUpgrade: (): WebSocketUpgradeOutcome => ({ kind: "pass" }),
            fetch: () => {
              httpRuns++
              return new Response("child miss", { status: 404 })
            },
          },
        })
      const request = new Request("http://test/private/a", { headers: { upgrade: "websocket" } })
      expect((await app.resolveWebSocketUpgrade(request)).kind).toBe("pass")
      const response = await app.fetch(request)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe("hidden")
      expect(checks).toBe(2)
      expect(httpRuns).toBe(0)
    })
  }

  test("stripped requests retain authentication through WebSocket pass and HTTP reuse", async () => {
    let passed: Request | undefined
    const app = server()
      .authenticate(token)
      .mount({
        path: "/private",
        stripPrefix: true,
        app: {
          resolveWebSocketUpgrade: (request: Request): WebSocketUpgradeOutcome => {
            passed = request
            expect(isAuthenticatedRequest(request)).toBe(true)
            return { kind: "pass" }
          },
          fetch: (request: Request) => {
            expect(passed).toBe(request)
            expect(isAuthenticatedRequest(request)).toBe(true)
            return new Response(new URL(request.url).pathname)
          },
        },
      })
    const request = new Request("http://test/private/a", {
      headers: { upgrade: "websocket", ...SIGNED_IN },
    })
    expect((await app.resolveWebSocketUpgrade(request)).kind).toBe("pass")
    expect(await (await app.fetch(request)).text()).toBe("/a")
  })
})
