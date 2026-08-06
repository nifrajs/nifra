import { afterEach, expect, test } from "bun:test"
import { server, silentLogger } from "@nifrajs/core"
import type { ResponseHeadersView } from "@nifrajs/core/server"
import { securityHeaders } from "@nifrajs/middleware"
import { type NodeServer, serve } from "../src/index.ts"

/**
 * The Node adapter's own wire, not core's outcome shape: statically declared response headers must
 * reach the socket byte-identically to the same headers written by an `onResponseHeaders` hook, on
 * every render the adapter has a distinct writer for (the direct JSON writer, the buffered-body
 * writer, and the Web `Response` fallback).
 */

let running: NodeServer | undefined
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})

const DECLARED = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const

function declaredAsHook(headers: ResponseHeadersView): void {
  for (const [name, value] of Object.entries(DECLARED)) {
    if (!headers.has(name)) headers.set(name, value)
  }
}

function routes(app: ReturnType<typeof server>) {
  return app
    .get("/json", () => ({ ok: true }))
    .get("/own", (c) => {
      c.set.headers["x-own"] = "1"
      return { ok: true }
    })
    .get("/collision", (c) => {
      c.set.headers["X-Frame-Options"] = "SAMEORIGIN"
      return { ok: true }
    })
    .get("/empty", (c) => {
      c.set.status = 204
      return undefined
    })
    .get("/cookies", (c) => {
      c.set.cookie("sid", "a")
      c.set.cookie("csrf", "b")
      return { ok: true }
    })
    .get("/redirect", () => new Response(null, { status: 302, headers: { location: "/dest" } }))
    .get("/text", () => new Response("plain", { headers: { "content-type": "text/plain" } }))
    .get("/boom", () => {
      throw new Error("x")
    })
}

const PATHS = [
  "/json",
  "/own",
  "/collision",
  "/empty",
  "/cookies",
  "/redirect",
  "/text",
  "/boom",
  "/missing",
] as const

/** Everything the socket carried, normalized for comparison. */
async function dump(base: string, path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { redirect: "manual" })
  const headers = [...res.headers]
    // Per-connection framing the adapter/runtime owns, not response state.
    .filter(([name]) => name !== "date" && name !== "keep-alive" && name !== "connection")
    .map(([name, value]) => [name, value] as [string, string])
  headers.sort()
  return { status: res.status, headers, body: await res.text() }
}

async function dumpAll(app: ReturnType<typeof server>): Promise<unknown[]> {
  running = await serve(app, { port: 0 })
  const base = `http://localhost:${running.port}`
  const out: unknown[] = []
  for (const path of PATHS) out.push(await dump(base, path))
  await running.stop({ drainMs: 0 })
  running = undefined
  return out
}

test("declared headers are byte-identical to the equivalent hook on every Node writer", async () => {
  const viaStatic = await dumpAll(
    routes(server({ logger: silentLogger })).responseHeaders(DECLARED),
  )
  const viaHook = await dumpAll(
    routes(server({ logger: silentLogger })).onResponseHeaders(declaredAsHook),
  )
  expect(viaStatic).toEqual(viaHook)
  // Not vacuous: the headers really shipped on each response.
  for (const entry of viaStatic) {
    const { headers } = entry as { headers: string[][] }
    expect(headers).toContainEqual(["referrer-policy", "no-referrer"])
    expect(headers).toContainEqual(["x-content-type-options", "nosniff"])
  }
})

test("a mixed-case collision ships one header line, with the value the route set", async () => {
  running = await serve(routes(server({ logger: silentLogger })).responseHeaders(DECLARED), {
    port: 0,
  })
  const res = await fetch(`http://localhost:${running.port}/collision`)
  expect([...res.headers].filter(([name]) => name === "x-frame-options")).toEqual([
    ["x-frame-options", "SAMEORIGIN"],
  ])
})

test("securityHeaders() ships the same wire it did as a hook", async () => {
  running = await serve(
    server()
      .use(securityHeaders({ hsts: { maxAge: 100 }, contentSecurityPolicy: "default-src 'self'" }))
      .get("/", () => ({ ok: true })),
    { port: 0 },
  )
  const res = await fetch(`http://localhost:${running.port}/`)
  expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  expect(res.headers.get("x-frame-options")).toBe("DENY")
  expect(res.headers.get("referrer-policy")).toBe("no-referrer")
  expect(res.headers.get("strict-transport-security")).toBe("max-age=100")
  expect(res.headers.get("content-security-policy")).toBe("default-src 'self'")
  // The render still owns framing and content type - the declared tier never touches either.
  expect(res.headers.get("content-type")).toBe(Response.json(0).headers.get("content-type"))
  expect(res.headers.get("content-length")).toBe("11")
})
