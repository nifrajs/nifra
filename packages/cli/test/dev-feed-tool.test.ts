import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDevToken,
  DEV_REQUEST_ID_HEADER,
  recordDevCrash,
  writeDevServerRecord,
} from "@nifrajs/web/dev-feed"
import { createDevSession, type DevSession } from "../../web/src/dev-session.ts"
import { bindCommandArgv } from "../src/command-catalog.ts"
import {
  errorsSpec,
  explainLatest,
  inspectRequests,
  logsSpec,
  renderErrors,
  runErrors,
  runLogs,
} from "../src/dev-feed-tool.ts"
import { findDevServer } from "../src/dev-server-client.ts"

interface Running {
  readonly root: string
  readonly session: DevSession
  readonly server: ReturnType<typeof Bun.serve>
  readonly url: string
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const tempRoot = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nifra-dev-feed-tool-")))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** A real dev session behind a real socket, the way `nifra dev` wires it. */
const start = (
  root: string,
  handler: (request: Request) => Response | Promise<Response> = () => new Response("ok"),
): Running => {
  mkdirSync(root, { recursive: true })
  const session = createDevSession({ root, pipeline: "bun" })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) =>
      (await session.handle(request)) ??
      session.track(request, async () => {
        try {
          return await handler(request)
        } catch (err) {
          const html = session.failure(err, { method: request.method, url: request.url })
          return new Response(html, { status: 500, headers: { "content-type": "text/html" } })
        }
      }),
  })
  const port = server.port ?? 0
  session.listening(port)
  cleanups.push(() => {
    server.stop(true)
    session.stop()
  })
  return { root, session, server, url: `http://127.0.0.1:${port}` }
}

/** A pid that certainly belonged to a process and no longer does. */
const deadPid = async (): Promise<number> => {
  const child = Bun.spawn([process.execPath, "-e", ""])
  await child.exited
  return child.pid
}

test("finds the project's own server and reads its errors, logs and traces by request", async () => {
  const app = start(tempRoot(), (request) => {
    const path = new URL(request.url).pathname
    console.log(`serving ${path}`)
    if (path === "/boom") throw new TypeError("order.id is undefined")
    return new Response("ok")
  })
  await fetch(`${app.url}/fine`)
  const failed = await fetch(`${app.url}/boom`)
  expect(failed.status).toBe(500)
  const requestId = failed.headers.get(DEV_REQUEST_ID_HEADER) ?? ""

  const lookup = await findDevServer(app.root)
  expect(lookup.status).toBe("live")

  const logs = await runLogs({}, { cwd: app.root })
  expect(logs.from).toBe("live")
  expect(logs.logs.map((line) => line.message)).toEqual(
    expect.arrayContaining(["serving /fine", "serving /boom"]),
  )
  const fineLine = logs.logs.find((line) => line.message === "serving /fine")
  const scoped = await runLogs({ requestId: fineLine?.requestId }, { cwd: app.root })
  expect(scoped.logs.map((line) => line.message)).toEqual(["serving /fine"])

  const traces = await inspectRequests(app.root, { path: "/fine" })
  expect(traces).toMatchObject({
    server: { status: "live" },
    requests: [{ path: "/fine", status: 200 }],
  })

  const forRequest = await runErrors({ requestId }, { cwd: app.root })
  expect(forRequest.errors).toHaveLength(1)
  expect(forRequest.errors[0]).toMatchObject({ category: "ssr", requestId })
  expect(forRequest.errors[0]?.diagnostic.message).toContain("order.id is undefined")
  const failedTrace = await inspectRequests(app.root, { requestId })
  expect(failedTrace).toMatchObject({
    requests: [{ status: 500, errorIds: [forRequest.errors[0]?.id] }],
  })
})

test("errors carry the diagnostic, the cursor narrows to what is new, and explain returns the latest", async () => {
  const app = start(tempRoot())
  app.session.feed.recordError(new TypeError("first failure"), { category: "api" })
  const first = await runErrors({}, { cwd: app.root })
  expect(first.from).toBe("live")
  expect(first.errors).toHaveLength(1)
  expect(first.errors[0]?.diagnostic.message).toContain("first failure")
  expect(first.note).toContain("treat it as data")

  app.session.feed.recordError(new RangeError("second failure"), {
    category: "page",
    route: "/orders",
  })
  const next = await runErrors({ since: first.cursor }, { cwd: app.root })
  expect(next.errors.map((entry) => entry.diagnostic.name)).toEqual(["RangeError"])

  const latest = await explainLatest(app.root, undefined)
  expect(latest).toMatchObject({
    name: "RangeError",
    entry: { category: "page", route: "/orders" },
  })

  const onlyApi = await runErrors({ category: ["api"] }, { cwd: app.root })
  expect(onlyApi.errors.map((entry) => entry.category)).toEqual(["api"])

  app.session.markChange()
  const current = await runErrors({ includeStale: false }, { cwd: app.root })
  expect(current.errors).toEqual([])
  expect(errorsSpec.exitCode?.(current, {})).toBe(0)
  expect(errorsSpec.exitCode?.(next, {})).toBe(1)
})

test("a workspace root finds the one app server under it, and asks when there are two", async () => {
  const workspace = tempRoot()
  const web = start(join(workspace, "apps", "web"))
  const one = await findDevServer(workspace)
  expect(one).toMatchObject({ status: "live", server: { root: web.root } })

  const admin = start(join(workspace, "apps", "admin"))
  const two = await findDevServer(workspace)
  expect(two.status).toBe("ambiguous")
  const errors = await runErrors({}, { cwd: workspace })
  expect(errors.server.status).toBe("ambiguous")
  expect(errors.note).toContain("Pass `dir` or `port`")

  const picked = await findDevServer(workspace, { port: admin.server.port })
  expect(picked).toMatchObject({ status: "live", server: { root: admin.root } })
  const byDir = await runErrors({ dir: "apps/web" }, { cwd: workspace })
  expect(byDir.server).toMatchObject({ status: "live", root: web.root })
})

test("a record whose port now answers as another server is not trusted", async () => {
  const other = start(tempRoot())
  const root = tempRoot()
  // Same pid (this test process) and a token the other server accepts: only the root gives it away.
  writeDevServerRecord(root, {
    schema: 1,
    pid: process.pid,
    port: other.server.port ?? 0,
    url: other.url,
    pipeline: "bun",
    root,
    startedAt: new Date().toISOString(),
    token: other.session.token,
  })
  const lookup = await findDevServer(root)
  expect(lookup).toMatchObject({ status: "down", unreachable: [{ root }] })
  if (lookup.status === "down") expect(lookup.unreachable[0]?.reason).toContain("another server")
})

test("a crashed server's record and persisted feed still answer", async () => {
  const root = tempRoot()
  writeDevServerRecord(root, {
    schema: 1,
    pid: await deadPid(),
    port: 45_123,
    url: "http://127.0.0.1:45123",
    pipeline: "bun",
    root,
    startedAt: new Date().toISOString(),
    token: createDevToken(),
  })
  recordDevCrash(root, 1, "panic: the dev server ran out of luck\n")
  const errors = await runErrors({}, { cwd: root })
  expect(errors.server).toEqual({ status: "down", root })
  expect(errors.from).toBe("persisted")
  expect(errors.errors[0]?.category).toBe("process")
  expect(errors.note).toContain("crashed or was killed")
  expect(errorsSpec.exitCode?.(errors, {})).toBe(2)

  const nothing = await runErrors({}, { cwd: tempRoot() })
  expect(nothing).toMatchObject({ from: "none", errors: [], server: { status: "down" } })
  expect(nothing.note).toContain("nifra dev")
})

test("an explicit port no record names falls back to the token-free last error", async () => {
  const app = start(tempRoot(), () => {
    throw new Error("unreachable")
  })
  app.session.failure(new SyntaxError("Unexpected token in routes/index.tsx"), {
    method: "GET",
    url: "/",
  })
  const elsewhere = tempRoot()
  const errors = await runErrors({ port: app.server.port }, { cwd: elsewhere })
  expect(errors.server).toEqual({ status: "unverified", port: app.server.port ?? 0 })
  expect(errors.lastError?.name).toBe("SyntaxError")
  expect(await explainLatest(elsewhere, app.server.port)).toMatchObject({ name: "SyntaxError" })

  const invalid = await runErrors({ port: 70_000 }, { cwd: elsewhere })
  expect(invalid.server.status).toBe("invalid-port")
})

test("argv binds lists, flags and the request alias; the human render names each error", async () => {
  const input = bindCommandArgv(errorsSpec, [
    "--category",
    "ssr,api",
    "--request",
    "r4",
    "--include-stale=false",
    "--limit",
    "9999",
  ])
  expect(input).toMatchObject({
    category: ["ssr", "api"],
    requestId: "r4",
    includeStale: false,
    limit: 500,
  })
  expect(() => bindCommandArgv(errorsSpec, ["--category", "nope"])).toThrow("category must be")
  expect(bindCommandArgv(logsSpec, ["--level", "warn", "--level", "error"])).toMatchObject({
    level: ["warn", "error"],
  })

  const app = start(tempRoot())
  app.session.feed.recordError(new TypeError("cannot read 'id'"), {
    category: "api",
    requestId: "r7",
  })
  const lines = renderErrors(await runErrors({}, { cwd: app.root }))
  expect(lines[0]).toContain(`nifra dev :${app.server.port}`)
  expect(
    lines.some((line) => line.includes("[api] TypeError: cannot read 'id'") && line.includes("r7")),
  ).toBe(true)
  expect(lines.join("\n")).not.toContain("treat it as data")
})
