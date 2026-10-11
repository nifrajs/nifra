import { afterEach, describe, expect, test } from "bun:test"
import { type AnyServer, type RunningServer, server, silentLogger } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"

/**
 * `c.set.headers` belong to the request whatever the handler returns: a guard's `cache-control:
 * no-store` reaches a Response the handler built, the Response's own headers win, and the headers
 * that describe its body come from it alone.
 */

type Answer = { readonly status: number; readonly headers: Headers; readonly body: string }
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
        if (Array.isArray(value)) for (const item of value) headers.append(name, item)
        else headers.set(name, String(value))
      }
      for (const cookie of outcome.kind === "json" ? (outcome.cookies ?? []) : []) {
        headers.append("set-cookie", cookie)
      }
      const body =
        typeof outcome.body === "string"
          ? outcome.body
          : outcome.body instanceof Uint8Array
            ? new TextDecoder().decode(outcome.body)
            : ""
      return { status: outcome.status, headers, body }
    },
  ],
  [
    "bun listen",
    async (app, request) => {
      running ??= app.listen(0, { hostname: "127.0.0.1" })
      const url = new URL(request.url)
      const response = await fetch(`http://127.0.0.1:${running.port}${url.pathname}`, {
        headers: request.headers,
        redirect: "manual",
      })
      return { status: response.status, headers: response.headers, body: await response.text() }
    },
  ],
]

const shared = new Response(null, { status: 204, headers: { "x-own": "1" } })

function app(): AnyServer {
  return server({ logger: silentLogger })
    .use(nodeDirect())
    .beforeHandle((c) => {
      if (c.req.headers.get("x-user") !== "alice") return undefined
      c.set.headers["cache-control"] = "no-store"
      c.set.headers["x-guard"] = "1"
      c.set.headers["content-type"] = "application/json"
      c.set.headers["content-length"] = "999"
      return undefined
    })
    .get("/built", () => new Response("data", { headers: { "content-type": "text/plain" } }))
    .get("/own", () => new Response("data", { headers: { "cache-control": "public, max-age=60" } }))
    .get("/shared", () => shared)
    .get("/guarded", () => Response.redirect("http://x/home", 302))
}

const as = (user: string, path: string) =>
  new Request(`http://x${path}`, { headers: { "x-user": user } })

describe("a handler-built Response carries the request's c.set headers", () => {
  for (const [lane, send] of LANES) {
    test(`${lane}: merged, the Response's own win, and body headers stay its own`, async () => {
      const routes = app()
      const built = await send(routes, as("alice", "/built"))
      expect(built.headers.get("cache-control")).toBe("no-store")
      expect(built.headers.get("x-guard")).toBe("1")
      expect(built.headers.get("content-type")).toStartWith("text/plain")
      expect(built.headers.get("content-length")).not.toBe("999")
      expect(built.body).toBe("data")

      const own = await send(routes, as("alice", "/own"))
      expect(own.headers.get("cache-control")).toBe("public, max-age=60")
      expect(own.headers.get("x-guard")).toBe("1")

      const guarded = await send(routes, as("alice", "/guarded"))
      expect(guarded.status).toBe(302)
      expect(guarded.headers.get("cache-control")).toBe("no-store")
    })

    test(`${lane}: a Response shared across requests never carries one request's headers to another`, async () => {
      const routes = app()
      const alice = await send(routes, as("alice", "/shared"))
      expect(alice.status).toBe(204)
      expect(alice.headers.get("x-guard")).toBe("1")
      expect(alice.headers.get("x-own")).toBe("1")
      const bob = await send(routes, as("bob", "/shared"))
      expect(bob.headers.get("x-guard")).toBeNull()
      expect(bob.headers.get("x-own")).toBe("1")
      expect(shared.headers.has("x-guard")).toBe(false)
    })
  }
})
