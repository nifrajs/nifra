import { describe, expect, test } from "bun:test"
import {
  defineAssurancePolicy,
  evaluateRouteAssurance,
  NIFRA_ASSURANCE,
  withRouteAssurance,
} from "../src/assurance.ts"
import { authenticated, rejected, server, status } from "../src/index.ts"
import { reflectRoutes } from "../src/reflection.ts"
import { websocket } from "../src/ws.ts"

/**
 * Sockets are routes to reflection: each `app.ws()` path is reflected under the pseudo-method `"WS"`
 * with the evidence its handshake enforces, so assurance sees every socket. A socket claims only what
 * its handshake runs - the auth guards in its route chain and the app's request hooks - never what an
 * HTTP `GET` there would get from code a socket's handlers never pass through.
 */

const socketsOf = (app: unknown) => reflectRoutes(app).filter((route) => route.method === "WS")
const idsOf = (route: { readonly assurance?: readonly { readonly id: string }[] } | undefined) =>
  (route?.assurance ?? []).map((item) => item.id)

describe("WebSocket routes in reflection", () => {
  test("each socket path is reflected as WS beside the HTTP routes", () => {
    const app = server()
      .use(websocket())
      .get("/http", () => "ok")
      .ws("/chat", {})
      .ws("/rooms/:id?", {})
    expect(reflectRoutes(app).map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /http",
      "WS /chat",
      "WS /rooms",
      "WS /rooms/:id",
    ])
  })

  test("a socket after authenticate() carries the evidence; one before it does not", () => {
    const app = server()
      .use(websocket())
      .ws("/public", {})
      .authenticate({
        id: "test-auth",
        mode: "sync",
        run: (input) =>
          input.headers.get("authorization") === "Bearer good"
            ? authenticated({ userId: "u1" })
            : rejected(),
      })
      .ws("/private", {})
    const [publicSocket, privateSocket] = socketsOf(app)
    expect(publicSocket?.path).toBe("/public")
    expect(idsOf(publicSocket)).toEqual([])
    expect(privateSocket?.path).toBe("/private")
    expect(idsOf(privateSocket)).toEqual([NIFRA_ASSURANCE.AUTHENTICATED])
  })

  test("evidence a handshake never enforces is not claimed for a socket", () => {
    const journal = withRouteAssurance(<S>(app: S): S => app, {
      id: "app.journaled",
      source: "journal",
      scope: "subsequent",
    })
    const app = server()
      .use(websocket())
      .use(journal)
      .get("/http", () => "ok")
      .ws("/socket", {})
    const http = reflectRoutes(app).find((route) => route.method === "GET")
    expect(idsOf(http)).toEqual(["app.journaled"])
    expect(idsOf(socketsOf(app)[0])).toEqual([])
  })

  test("a refused handshake is not proof: a user's own guard is enforced but claims nothing", async () => {
    const app = server()
      .use(websocket())
      .beforeHandle(() => status(401, { error: "no" }))
      .ws("/socket", {})
    const outcome = await app.resolveWebSocketUpgrade(
      new Request("http://t/socket", { headers: { upgrade: "websocket" } }),
    )
    expect(outcome.kind).toBe("reject")
    expect(idsOf(socketsOf(app)[0])).toEqual([])
  })

  test("route assurance classifies sockets: a WS rule can require authentication", () => {
    const policy = defineAssurancePolicy({
      rules: [
        { name: "sockets", match: { methods: ["WS"] }, require: [NIFRA_ASSURANCE.AUTHENTICATED] },
        { name: "reads", match: { methods: ["GET"] }, require: [] },
      ],
    })
    const auth = {
      id: "test-auth",
      mode: "sync" as const,
      run: () => authenticated({ userId: "u1" }),
    }
    const open = server()
      .use(websocket())
      .get("/http", () => "ok")
      .ws("/socket", {})
    const guarded = server().use(websocket()).authenticate(auth).ws("/socket", {})
    expect(evaluateRouteAssurance(open, policy).findings).toMatchObject([
      { code: "missing-evidence", method: "WS", path: "/socket" },
    ])
    expect(evaluateRouteAssurance(guarded, policy)).toMatchObject({ ok: true, findings: [] })
  })

  test("a policy written for HTTP methods reports a socket as unclassified", () => {
    const policy = defineAssurancePolicy({
      rules: [{ name: "reads", match: { methods: ["GET"] }, require: [] }],
    })
    const app = server()
      .use(websocket())
      .get("/http", () => "ok")
      .ws("/socket", {})
    expect(evaluateRouteAssurance(app, policy).findings).toMatchObject([
      { code: "unclassified-route", method: "WS", path: "/socket" },
    ])
  })
})
