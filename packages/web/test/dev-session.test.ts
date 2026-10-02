import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEV_FEED_PATHS,
  DEV_REQUEST_ID_HEADER,
  DEV_SERVER_LOG_FILE,
  DEV_SERVER_RECORD_FILE,
  DEV_TOKEN_HEADER,
  readDevServerRecord,
} from "../src/dev-feed.ts"
import {
  buildFailureError,
  createDevSession,
  type DevSession,
  isDevAgentPath,
  isLoopbackHost,
} from "../src/dev-session.ts"
import { LAST_ERROR_PATH } from "../src/diagnostic.ts"

const roots: string[] = []
const sessions: DevSession[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) session.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const open = (record = false): { session: DevSession; root: string } => {
  const root = mkdtempSync(join(tmpdir(), "nifra-dev-session-"))
  roots.push(root)
  const session = createDevSession({ root, pipeline: "bun", record })
  sessions.push(session)
  return { session, root }
}

const get = (
  session: DevSession,
  path: string,
  init: { token?: string; host?: string; method?: string } = {},
): Promise<Response | undefined> =>
  session.handle(
    new Request(`http://127.0.0.1:4000${path}`, {
      method: init.method ?? "GET",
      headers: headersFor(init),
    }),
  )

const headersFor = (init: { token?: string; host?: string }): Headers => {
  const headers = new Headers({ host: init.host ?? "127.0.0.1:4000" })
  if (init.token !== undefined) headers.set(DEV_TOKEN_HEADER, init.token)
  return headers
}

const body = async (response: Response | undefined): Promise<Record<string, unknown>> => {
  if (response === undefined) throw new Error("expected the session to answer")
  return response.json()
}

test("loopback hosts only", () => {
  for (const host of [
    "localhost",
    "localhost:3000",
    "app.localhost:3000",
    "127.0.0.1:3000",
    "127.9.8.7",
    "[::1]:3000",
    "LOCALHOST",
  ]) {
    expect(isLoopbackHost(host)).toBe(true)
  }
  for (const host of [
    null,
    "",
    "evil.com",
    "localhost.evil.com",
    "127.0.0.1.nip.io",
    "10.0.0.2:3000",
    "[::2]",
    "[::1",
    "0.0.0.0:3000",
  ]) {
    expect(isLoopbackHost(host)).toBe(false)
  }
})

test("isDevAgentPath names exactly the session's paths", () => {
  expect(isDevAgentPath(DEV_FEED_PATHS.errors)).toBe(true)
  expect(isDevAgentPath(LAST_ERROR_PATH)).toBe(true)
  expect(isDevAgentPath("/__nifra/client.js")).toBe(false)
  expect(isDevAgentPath("/api/errors")).toBe(false)
})

test("agent reads need a loopback Host AND the token; last-error keeps its token-free contract", async () => {
  const { session } = open()
  expect(await get(session, "/about")).toBeUndefined()
  expect(await get(session, "/__nifra/client.js")).toBeUndefined()
  // DNS rebinding: a page on evil.com that resolved to 127.0.0.1 still sends its own Host.
  const rebound = await get(session, DEV_FEED_PATHS.errors, {
    token: session.token,
    host: "evil.com:4000",
  })
  expect(rebound?.status).toBe(403)
  expect((await get(session, LAST_ERROR_PATH, { host: "evil.com" }))?.status).toBe(403)
  expect((await get(session, LAST_ERROR_PATH))?.status).toBe(200)
  expect((await get(session, DEV_FEED_PATHS.errors))?.status).toBe(401)
  expect((await get(session, DEV_FEED_PATHS.logs, { token: "x".repeat(43) }))?.status).toBe(401)
  const ok = await get(session, DEV_FEED_PATHS.errors, { token: session.token })
  expect(ok?.status).toBe(200)
  expect(ok?.headers.get("cache-control")).toBe("no-store")
  expect(ok?.headers.get("x-nifra-dev-feed")).toBe("true")
  expect(
    (await get(session, DEV_FEED_PATHS.errors, { token: session.token, method: "DELETE" }))?.status,
  ).toBe(405)
  // An unauthorized answer carries no data.
  expect(JSON.stringify(await body(await get(session, DEV_FEED_PATHS.logs)))).not.toContain(
    session.token,
  )
})

test("identity reports the server and its counts", async () => {
  const { session, root } = open()
  session.listening(4000)
  const identity = await body(await get(session, DEV_FEED_PATHS.identity, { token: session.token }))
  expect(identity).toMatchObject({ schema: 1, pid: process.pid, port: 4000, pipeline: "bun", root })
})

test("tracked requests get an id header, a trace, and tag what they log", async () => {
  const { session } = open()
  const response = await session.track(
    new Request("http://127.0.0.1:4000/orders?page=2", { method: "POST" }),
    async () => {
      console.log("handling order")
      return new Response("created", {
        status: 201,
        headers: { "content-length": "7", "x-nifra-isr": "MISS" },
      })
    },
  )
  const requestId = response.headers.get(DEV_REQUEST_ID_HEADER) ?? ""
  expect(requestId).toMatch(/^r\d+$/)
  const traces = await body(
    await get(session, `${DEV_FEED_PATHS.requests}?requestId=${requestId}`, {
      token: session.token,
    }),
  )
  expect(traces.requests).toEqual([
    expect.objectContaining({
      requestId,
      method: "POST",
      path: "/orders?page=2",
      status: 201,
      bytes: 7,
      isr: "MISS",
      logCount: 1,
    }),
  ])
  expect(session.feed.logs({ requestId }).logs[0]?.message).toBe("handling order")
})

test("immutable response headers still get the request id", async () => {
  const { session } = open()
  const response = await session.track(new Request("http://127.0.0.1:4000/go"), async () =>
    Response.redirect("http://127.0.0.1:4000/there", 302),
  )
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe("http://127.0.0.1:4000/there")
  expect(response.headers.get(DEV_REQUEST_ID_HEADER)).toMatch(/^r\d+$/)
})

test("a handler that throws still closes its trace as a 500, then rethrows", async () => {
  const { session } = open()
  await expect(
    session.track(new Request("http://127.0.0.1:4000/x"), async () => {
      throw new Error("escaped")
    }),
  ).rejects.toThrow("escaped")
  expect(session.feed.requests().requests[0]?.status).toBe(500)
})

test("boundary-caught loader failures land as page errors with route and request id", async () => {
  const { session } = open()
  const response = await session.track(new Request("http://127.0.0.1:4000/users/7"), async () => {
    session.onLoaderError(new Error("user lookup failed"), {
      request: new Request("http://127.0.0.1:4000/users/7"),
      route: "/users/:id",
    })
    return new Response("boundary page", { status: 500 })
  })
  const requestId = response.headers.get(DEV_REQUEST_ID_HEADER)
  const { errors } = await body(
    await get(session, `${DEV_FEED_PATHS.errors}?category=page`, { token: session.token }),
  )
  expect(errors).toEqual([
    expect.objectContaining({
      category: "page",
      route: "/users/:id",
      requestId,
      diagnostic: expect.objectContaining({ request: { method: "GET", url: "/users/7" } }),
    }),
  ])
  expect(session.feed.requests().requests[0]?.errorIds).toHaveLength(1)
})

test("an output-guard refusal carries its own code and fix", () => {
  const { session } = open()
  const error = new Error(
    "[nifra/web] loader of /admin declares sensitive field(s) passwordHash in loaderOutput. Remove them",
  )
  error.name = "OutputGuardError"
  session.onLoaderError(error, {
    request: new Request("http://127.0.0.1:4000/admin"),
    route: "/admin",
  })
  const [entry] = session.feed.errors().errors
  expect(entry?.diagnostic.code).toBe("NIFRA_OUTPUT_SENSITIVE_FIELD")
  expect(entry?.diagnostic.fix).toContain("t.declassified")
})

test("core's unhandled-error log line becomes an api error tied to its request", async () => {
  const { session } = open()
  const response = await session.track(new Request("http://127.0.0.1:4000/api/boom"), async () => {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        message: "unhandled request error",
        method: "GET",
        path: "/api/boom",
        name: "TypeError",
        detail: "cannot read x",
        stack: "TypeError: cannot read x\n    at handler (/app/backend/app.ts:9:3)",
        time: "now",
      })}\n`,
    )
    return new Response("internal_error", { status: 500 })
  })
  const [entry] = session.feed.errors({ categories: ["api"] }).errors
  expect(entry?.category).toBe("api")
  expect(entry?.requestId).toBe(response.headers.get(DEV_REQUEST_ID_HEADER) ?? "")
  expect(entry?.diagnostic.name).toBe("TypeError")
  expect(entry?.diagnostic.request).toEqual({ method: "GET", url: "/api/boom" })
  expect(entry?.diagnostic.frames[0]?.file).toBe("/app/backend/app.ts")
  const [line] = session.feed.logs({ grep: "unhandled request error" }).logs
  expect(line?.level).toBe("error")
  expect(line?.message).toContain('"detail":"cannot read x"')
})

test("failure() renders the overlay and records the same redacted diagnostic everywhere", async () => {
  const root = mkdtempSync(join(tmpdir(), "nifra-dev-session-"))
  roots.push(root)
  process.env.NIFRA_TEST_SESSION_SECRET = "abcdefghijklmnopqrstuvwxyz-0123456789"
  let session: DevSession
  try {
    session = createDevSession({ root, pipeline: "vite", record: false })
  } finally {
    delete process.env.NIFRA_TEST_SESSION_SECRET
  }
  sessions.push(session)
  const html = session.failure(new Error("render broke abcdefghijklmnopqrstuvwxyz-0123456789"), {
    method: "GET",
    url: "/",
  })
  expect(html).toContain("render broke")
  expect(html).not.toContain("abcdefghijklmnopqrstuvwxyz-0123456789")
  const last = await body(await get(session, LAST_ERROR_PATH))
  expect(String(last.message)).toContain("[redacted:NIFRA_TEST_SESSION_SECRET]")
  const [entry] = session.feed.errors({ categories: ["ssr"] }).errors
  expect(entry?.diagnostic.message).toBe(String(last.message))
})

test("build failures locate the file a bundler names, and a passing build clears them", () => {
  const { session, root } = open()
  const file = join(root, "frontend/widget.tsx")
  mkdirSync(join(root, "frontend"))
  writeFileSync(file, "a\nb\nimport x from 'nope'\nd\n")
  const bundle = new AggregateError(
    [{ message: 'Could not resolve "nope"', position: { file, line: 3, column: 14 } }],
    "Bundle failed",
  )
  session.buildFailed(bundle, "client build failed")
  const [entry] = session.feed.errors({ categories: ["build"] }).errors
  expect(entry?.diagnostic.message).toContain('Could not resolve "nope"')
  expect(entry?.diagnostic.codeframe?.line).toBe(3)
  session.buildPassed()
  expect(session.feed.errors({ categories: ["build"] }).errors).toHaveLength(0)
})

test("buildFailureError keeps an Error's own frames when there is no position", () => {
  const cause = new Error("transform exploded")
  const error = buildFailureError(cause, "/x.tsx failed to transform")
  expect(error.name).toBe("BuildError")
  expect(error.message).toContain("transform exploded")
  expect(error.stack).toContain("    at ")
  expect(buildFailureError("plain", "label").message).toContain("plain")
})

test("markChange makes earlier errors stale", () => {
  const { session } = open()
  session.buildFailed(new Error("x"), "label")
  session.markChange()
  expect(session.feed.errors().errors[0]?.stale).toBe(true)
})

test("the crash monitor records a process error without handling the crash", () => {
  const { session } = open()
  const before = process.listenerCount("uncaughtException")
  process.emit("uncaughtExceptionMonitor", new Error("fatal"), "uncaughtException")
  expect(process.listenerCount("uncaughtException")).toBe(before)
  expect(session.feed.errors({ categories: ["process"] }).errors).toHaveLength(1)
  session.stop()
  process.emit("uncaughtExceptionMonitor", new Error("after stop"), "uncaughtException")
  expect(session.feed.errors({ categories: ["process"] }).errors).toHaveLength(1)
})

test("listening writes the discovery record; stop removes it and detaches capture", () => {
  const originalLog = console.log
  const { session, root } = open(true)
  session.listening(4567)
  const record = readDevServerRecord(root)
  expect(record).toMatchObject({ port: 4567, pid: process.pid, pipeline: "bun", root })
  expect(record?.token).toBe(session.token)
  session.feed.recordError(new Error("persist me"), { category: "page" })
  expect(existsSync(join(root, DEV_SERVER_LOG_FILE))).toBe(true)
  session.stop()
  session.stop()
  expect(existsSync(join(root, DEV_SERVER_RECORD_FILE))).toBe(false)
  // The persisted log outlives the server: that is what a crash investigation reads.
  expect(existsSync(join(root, DEV_SERVER_LOG_FILE))).toBe(true)
  expect(console.log).toBe(originalLog)
})

test("record: false writes nothing to disk", () => {
  const { session, root } = open(false)
  session.listening(4567)
  session.feed.recordError(new Error("x"), { category: "page" })
  expect(existsSync(join(root, ".nifra"))).toBe(false)
})
