import { afterEach, describe, expect, test } from "bun:test"
import { authed } from "@nifrajs/better-auth"
import { type AnyServer, type RunningServer, server } from "@nifrajs/core"
import { nodeDirect } from "@nifrajs/core/node-direct"
import { websocket } from "@nifrajs/core/ws"
import { t } from "@nifrajs/schema"

const stubAuth = {
  handler: async (): Promise<Response> => Response.json({ ok: true }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) =>
      headers.get("cookie") === "session=valid"
        ? { user: { id: "u1" }, session: { id: "s1", expiresAt: 0 } }
        : null,
  },
  options: { basePath: "/api/auth" },
}

type Answer = { status: number; headers: Headers; body: string }
type Lane = (app: AnyServer, request: Request) => Promise<Answer>

let running: RunningServer | undefined
afterEach(() => {
  running?.stop(true)
  running = undefined
})

const LANES: ReadonlyArray<readonly [string, Lane]> = [
  [
    "app.fetch",
    async (app, request) => {
      const response = await app.fetch(request)
      return { status: response.status, headers: response.headers, body: await response.text() }
    },
  ],
  [
    "node",
    async (app, request) => {
      const outcome = await app.resolveNode(request)
      if (outcome.kind === "response") {
        const { response } = outcome
        return { status: response.status, headers: response.headers, body: await response.text() }
      }
      const headers = new Headers()
      for (const [name, value] of Object.entries(outcome.headers ?? {})) {
        headers.set(name, Array.isArray(value) ? value.join(", ") : String(value))
      }
      const body = typeof outcome.body === "string" ? outcome.body : ""
      return { status: outcome.status, headers, body }
    },
  ],
  [
    "bun listen",
    async (app, request) => {
      running = app.listen(0, { hostname: "127.0.0.1" })
      const url = new URL(request.url)
      const response = await fetch(`http://127.0.0.1:${running.port}${url.pathname}`, {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
        redirect: "manual",
      })
      return { status: response.status, headers: response.headers, body: await response.text() }
    },
  ],
]

const order = (cookie?: string): Request => {
  const headers = new Headers({ "content-type": "application/json" })
  if (cookie !== undefined) headers.set("cookie", cookie)
  return new Request("http://x/orders", { method: "POST", headers, body: '{"wrong":1}' })
}

describe("authed() refuses before validation with its own denial", () => {
  for (const [lane, send] of LANES) {
    test(`${lane}: the unauthenticated status, body and headers; with a session the body is a 422`, async () => {
      const app = server()
        .use(nodeDirect())
        .use(
          authed(stubAuth, {
            unauthenticated: {
              status: 403,
              body: { error: "login_required" },
              headers: { "www-authenticate": "Session" },
            },
          }),
        )
        .post("/orders", { body: t.object({ name: t.string() }) }, () => ({ ok: true }))
      const refused = await send(app, order())
      expect(refused.status).toBe(403)
      expect(refused.headers.get("www-authenticate")).toBe("Session")
      expect(JSON.parse(refused.body)).toEqual({ error: "login_required" })
      expect((await send(app, order("session=valid"))).status).toBe(422)
    })

    test(`${lane}: redirectTo keeps its redirect`, async () => {
      const app = server()
        .use(nodeDirect())
        .use(authed(stubAuth, { redirectTo: "/login" }))
        .post("/orders", { body: t.object({ name: t.string() }) }, () => ({ ok: true }))
      const refused = await send(app, order())
      expect(refused.status).toBe(302)
      expect(refused.headers.get("location")).toBe("/login")
    })
  }

  test("a WebSocket handshake gets the same denial", async () => {
    const app = server()
      .use(websocket())
      .use(
        authed(stubAuth, { unauthenticated: { status: 403, body: { error: "login_required" } } }),
      )
      .ws("/socket", { upgrade: () => ({}) })
    const resolve = app.resolveWebSocketUpgrade
    if (resolve === undefined) throw new Error("the server takes no upgrades")
    const handshake = (headers: Record<string, string>) =>
      resolve.call(
        app,
        new Request("http://x/socket", { headers: { upgrade: "websocket", ...headers } }),
      )
    const refused = await handshake({})
    if (refused.kind !== "reject") throw new Error(`expected a refusal, got ${refused.kind}`)
    expect(refused.response.status).toBe(403)
    expect(await refused.response.json()).toEqual({ error: "login_required" })
    expect((await handshake({ cookie: "session=valid" })).kind).toBe("upgrade")
  })
})
