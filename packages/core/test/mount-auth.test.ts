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
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the invalid decision under test.
    const invalid = {
      id: "invalid",
      mode: "sync",
      run: () => ({}),
    } as unknown as AuthenticationStage<unknown>
    const deciding = server({ logger }).authenticate(invalid).mountFetch("/m", reach)
    expect(await ask(throwing, "/m")).toEqual([503, '{"ok":false,"error":"auth_unavailable"}'])
    expect(await ask(deciding, "/m")).toEqual([503, '{"ok":false,"error":"auth_unavailable"}'])
    expect(reached).toBe(0)
    expect(logged).toEqual([
      "authenticate() stage failed before a mount",
      "authenticate() stage failed before a mount",
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
})
