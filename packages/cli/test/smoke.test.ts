import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSmokeFixture, runSmoke, type SmokeFixture } from "../src/smoke.ts"

const app = {
  fetch(request: Request): Response {
    const path = new URL(request.url).pathname
    if (path === "/") {
      return new Response("<html><body>SSR_MARKER</body></html>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'",
        },
      })
    }
    if (path === "/api/ping") return Response.json({ ok: true })
    if (path === "/callback") return Response.json({ ok: false }, { status: 401 })
    return Response.json({ error: "not_found" }, { status: 404 })
  },
}

const fixture: SmokeFixture = {
  app,
  ssr: { path: "/", marker: "SSR_MARKER" },
  mountedApi: [{ id: "ping", path: "/api/ping", expectedStatus: 200, contentType: "json" }],
  securityHeaders: [
    {
      id: "csp",
      path: "/",
      expectedStatus: 200,
      expectedHeaders: { "content-security-policy": "default-src 'self'" },
    },
  ],
  authCallbacks: [{ id: "callback", path: "/callback", expectedStatus: 401, contentType: "json" }],
  contract: async () => ({ ok: true, failures: 0, gaps: 0 }),
  hydration: async () => undefined,
}

test("runSmoke executes required and optional checks without exposing response bodies", async () => {
  const report = await runSmoke(fixture, { inProcess: true })
  expect(report.ok).toBe(true)
  expect(report.counts.failed).toBe(0)
  expect(report.checks.some((check) => check.category === "ssr" && check.status === "pass")).toBe(
    true,
  )
  expect(report.checks.some((check) => check.category === "auth" && check.status === "pass")).toBe(
    true,
  )
  expect(JSON.stringify(report)).not.toContain("SSR_MARKER")
  expect(JSON.stringify(report)).not.toContain("not_found")
})

test("runSmoke exercises the production start/stop lifecycle through an adapter seam", async () => {
  let stopped = false
  const report = await runSmoke({
    ...fixture,
    start: () => ({
      origin: "http://smoke.invalid",
      fetch: app.fetch,
      stop: () => {
        stopped = true
      },
    }),
  })
  expect(report.ok).toBe(true)
  expect(stopped).toBe(true)
  expect(report.mode).toBe("production")
})

test("runSmoke fails closed when production start is not configured", async () => {
  const report = await runSmoke(fixture)
  expect(report.ok).toBe(false)
  expect(report.checks).toContainEqual(
    expect.objectContaining({ category: "start", status: "fail" }),
  )
})

test("runSmoke rejects external request targets and non-404 not-found witnesses", async () => {
  const external = await runSmoke(
    {
      ...fixture,
      mountedApi: [{ ...fixture.mountedApi![0]!, path: "https://example.invalid/data" }],
    } as SmokeFixture,
    { inProcess: true },
  )
  expect(external.ok).toBe(false)
  expect(external.checks[0]?.message).toContain("mountedApi[0].path")

  const wrongStatus = await runSmoke(
    { ...fixture, notFound: { id: "missing", path: "/missing", expectedStatus: 200 } },
    { inProcess: true },
  )
  expect(wrongStatus.ok).toBe(false)
  expect(wrongStatus.checks[0]?.message).toContain("notFound.expectedStatus")
})

test("runSmoke validates the app, server origin, and contract failure counts", async () => {
  const invalidApp = await runSmoke(
    { ...fixture, app: { fetch: undefined } } as unknown as SmokeFixture,
    { inProcess: true },
  )
  expect(invalidApp.ok).toBe(false)
  expect(invalidApp.checks[0]?.message).toContain("fixture.app.fetch")

  const invalidOrigin = await runSmoke({
    ...fixture,
    start: () => ({ origin: "https://user:secret@example.invalid/base", stop: () => undefined }),
  })
  expect(invalidOrigin.ok).toBe(false)
  expect(invalidOrigin.checks).toContainEqual(
    expect.objectContaining({ category: "start", status: "fail" }),
  )

  const contractFailure = await runSmoke(
    { ...fixture, contract: async () => ({ ok: true, gaps: 1 }) },
    { inProcess: true },
  )
  expect(contractFailure.ok).toBe(false)
  expect(contractFailure.checks).toContainEqual(
    expect.objectContaining({ category: "contract", status: "fail" }),
  )
})

test("runSmoke bounds response bodies before parsing them", async () => {
  const huge = new Response(JSON.stringify({ data: "x".repeat(1_048_576) }), {
    headers: { "content-type": "application/json" },
  })
  const boundedFixture: SmokeFixture = {
    ...fixture,
    app: {
      fetch(request) {
        return new URL(request.url).pathname === "/api/huge"
          ? huge.clone()
          : fixture.app.fetch(request)
      },
    },
    mountedApi: [{ id: "huge", path: "/api/huge", expectedStatus: 200, contentType: "json" }],
  }
  const report = await runSmoke(boundedFixture, { inProcess: true })
  expect(report.ok).toBe(false)
  expect(report.checks).toContainEqual(
    expect.objectContaining({ category: "api", id: "huge", message: "response body is too large" }),
  )
})

test("loadSmokeFixture refuses traversal and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-smoke-loader-"))
  const outside = await mkdtemp(join(tmpdir(), "nifra-smoke-outside-"))
  try {
    const outsideFixture = join(outside, "fixture.ts")
    await writeFile(outsideFixture, "export default {}\n")
    await expect(loadSmokeFixture(root, "../missing.ts")).rejects.toThrow(
      /not found|inside the project/,
    )
    await symlink(outsideFixture, join(root, "fixture.ts"))
    await expect(loadSmokeFixture(root, "fixture.ts")).rejects.toThrow(/inside the project/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

// A partner-host app: the gate in front decides what `partner.example` may load.
const partnerApp = (gate: (path: string) => boolean) => ({
  fetch(request: Request): Response {
    const path = new URL(request.url).pathname
    if (request.headers.get("host") === "partner.example" && !gate(path))
      return new Response("Not Found", { status: 404 })
    if (path === "/" || path === "/login")
      return new Response(
        '<html><head><link rel="stylesheet" href="/assets/app-1.css"><script type="module" src="/assets/entry-1.js"></script></head><body>SSR_MARKER</body></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      )
    if (path === "/assets/app-1.css")
      return new Response("body{background:url(/assets/bg-1.png)}", {
        headers: { "content-type": "text/css" },
      })
    if (path === "/assets/entry-1.js")
      return new Response('import("./route-1.js")', {
        headers: { "content-type": "text/javascript" },
      })
    if (path === "/assets/route-1.js" || path === "/assets/bg-1.png")
      return new Response("x", { headers: { "content-type": "text/javascript" } })
    if (path === "/api/ping") return Response.json({ ok: true })
    return new Response("Not Found", { status: 404 })
  },
})
const hosts = [{ id: "partner", host: "partner.example", pages: ["/"], refused: ["/login"] }]

test("runSmoke hosts: a restricted host must load every file its pages reference", async () => {
  const pages = new Set(["/"])
  const exact = new Set([
    "/assets/app-1.css",
    "/assets/entry-1.js",
    "/assets/route-1.js",
    "/assets/bg-1.png",
  ])
  const ok = await runSmoke(
    { ...fixture, app: partnerApp((path) => pages.has(path) || exact.has(path)), hosts },
    { inProcess: true },
  )
  expect(ok.checks.find((check) => check.category === "hosts")).toEqual({
    category: "hosts",
    id: "partner",
    status: "pass",
  })
  // A gate that knows the pages and guesses the bundle's names: the page still answers 200, the
  // chunk it imports and the image its stylesheet loads do not.
  const guessed = /^\/assets\/[a-z]+-\d\.(?:js|css)$/
  const broken = await runSmoke(
    {
      ...fixture,
      app: partnerApp((path) => pages.has(path) || (guessed.test(path) && !path.includes("route"))),
      hosts,
    },
    { inProcess: true },
  )
  const check = broken.checks.find((entry) => entry.category === "hosts")
  expect(check?.status).toBe("fail")
  expect(check?.message).toBe(
    "2 failed: /assets/bg-1.png 404 (from /assets/app-1.css), /assets/route-1.js 404 (from /assets/entry-1.js)",
  )
  // A refused page that renders is a failure too.
  const open = await runSmoke(
    { ...fixture, app: partnerApp(() => true), hosts },
    { inProcess: true },
  )
  expect(open.checks.find((entry) => entry.category === "hosts")?.message).toBe(
    "1 failed: /login 200",
  )
})

test("runSmoke refuses a malformed host check", async () => {
  const report = await runSmoke(
    { ...fixture, hosts: [{ id: "x", host: "partner.example/evil", pages: ["/"] }] },
    { inProcess: true },
  )
  expect(report.checks[0]).toEqual(
    expect.objectContaining({
      category: "start",
      status: "fail",
      message: "hosts[0].host must be a host name",
    }),
  )
})
