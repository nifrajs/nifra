import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDevFeed,
  createDevToken,
  DEV_SERVER_LOG_FILE,
  DEV_SERVER_RECORD_FILE,
  type DevServerRecord,
  errorFromCoreLog,
  formatConsoleArgs,
  installCapture,
  isProcessAlive,
  parseCoreLogLine,
  readDevServerRecord,
  readPersistedFeed,
  recordDevCrash,
  removeDevServerRecord,
  runWithDevRequest,
  writeDevServerRecord,
} from "../src/dev-feed.ts"
import { createRedactor } from "../src/internal/secret-scan.ts"
import { encodeMappings, ssrSourceMaps } from "../src/internal/source-map.ts"

const roots: string[] = []
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "nifra-dev-feed-"))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const feedAt = (root = tempRoot(), env: Record<string, string> = {}) =>
  createDevFeed({ root, env, persist: false })

/** A fixed throw site, so repeats share a top frame the way a real repeated failure does (JSC inlines
 * a tiny helper, so the call site would otherwise become the top frame). */
const fail = (message: string): Error => {
  const error = new Error(message)
  error.stack = `Error: ${message}\n    at load (/app/routes/orders.backend.ts:4:11)`
  return error
}
const messages = (entries: readonly { diagnostic: { message: string } }[]): string[] =>
  entries.map((e) => e.diagnostic.message.replace(/^Error: /, ""))

test("repeats of one failure collapse into one entry with a count and the latest seq", () => {
  const feed = feedAt()
  const first = feed.recordError(fail("boom"), { category: "page" })
  feed.recordLog("log", "between")
  const second = feed.recordError(fail("boom"), { category: "page" })
  expect(second.id).toBe(first.id)
  expect(second.count).toBe(2)
  expect(second.seq).toBeGreaterThan(first.seq)
  expect(feed.errors().errors).toHaveLength(1)
  // A different category is a different failure even with the same text.
  feed.recordError(fail("boom"), { category: "api" })
  expect(feed.errors().errors).toHaveLength(2)
})

test("since returns only what happened after a cursor", () => {
  const feed = feedAt()
  feed.recordError(fail("old"), { category: "page" })
  feed.recordLog("info", "old line")
  const { cursor } = feed.errors()
  feed.recordError(fail("new"), { category: "page" })
  feed.recordLog("info", "new line")
  expect(messages(feed.errors({ since: cursor }).errors)).toEqual(["new"])
  expect(feed.logs({ since: cursor }).logs.map((l) => l.message)).toEqual(["new line"])
})

test("a file change marks earlier errors stale, and a repeat freshens them", () => {
  const feed = feedAt()
  feed.recordError(fail("boom"), { category: "page" })
  feed.markChange()
  const [stale] = feed.errors().errors
  expect(stale?.stale).toBe(true)
  expect(feed.errors({ includeStale: false }).errors).toHaveLength(0)
  feed.recordError(fail("boom"), { category: "page" })
  expect(feed.errors().errors[0]?.stale).toBe(false)
})

test("resolve clears open errors of one category only", () => {
  const feed = feedAt()
  feed.recordError(fail("bundle"), { category: "build" })
  feed.recordError(fail("loader"), { category: "page" })
  feed.resolve("build")
  expect(feed.errors().errors.map((e) => e.category)).toEqual(["page"])
  const all = feed.errors({ includeResolved: true }).errors
  expect(all.find((e) => e.category === "build")?.resolvedAt).toBeString()
  // The failure coming back reopens it.
  feed.recordError(fail("bundle"), { category: "build" })
  expect(
    feed
      .errors()
      .errors.map((e) => e.category)
      .sort(),
  ).toEqual(["build", "page"])
})

test("category and request filters narrow the error list", () => {
  const feed = feedAt()
  feed.startRequest("r1", "GET", "/a")
  runWithDevRequest({ feedId: feed.id, requestId: "r1", method: "GET", path: "/a" }, () =>
    feed.recordError(fail("in request"), { category: "page" }),
  )
  feed.recordError(fail("bundle"), { category: "build" })
  expect(feed.errors({ categories: ["build"] }).errors).toHaveLength(1)
  expect(messages(feed.errors({ requestId: "r1" }).errors)).toEqual(["in request"])
})

test("entries recorded inside a request carry its id and link to its trace", () => {
  const feed = feedAt()
  feed.startRequest("r7", "POST", "/orders?x=1")
  runWithDevRequest({ feedId: feed.id, requestId: "r7", method: "POST", path: "/orders" }, () => {
    feed.recordLog("log", "creating order")
    feed.recordError(fail("db down"), { category: "api" })
  })
  feed.finishRequest("r7", { status: 500, bytes: 21, isr: "MISS" }, 12.3456)
  const [trace] = feed.requests().requests
  expect(trace).toMatchObject({
    requestId: "r7",
    method: "POST",
    path: "/orders?x=1",
    status: 500,
    bytes: 21,
    isr: "MISS",
    durationMs: 12.35,
    logCount: 1,
  })
  expect(trace?.errorIds).toHaveLength(1)
  expect(feed.logs({ requestId: "r7" }).logs[0]?.message).toBe("creating order")
  // Another feed's request context is not this feed's request.
  const other = feedAt()
  runWithDevRequest({ feedId: other.id, requestId: "r1", method: "GET", path: "/" }, () =>
    feed.recordLog("log", "foreign"),
  )
  expect(feed.logs({ grep: "foreign" }).logs[0]?.requestId).toBeUndefined()
})

test("an in-flight request is listed without a status", () => {
  const feed = feedAt()
  feed.startRequest("r1", "GET", "/stream")
  const [trace] = feed.requests().requests
  expect(trace?.status).toBeUndefined()
  expect(feed.requests({ path: "/nope" }).requests).toHaveLength(0)
  expect(feed.requests({ requestId: "r1" }).requests).toHaveLength(1)
})

test("log filters: level, source, grep, request, limit", () => {
  const feed = feedAt()
  feed.recordLog("info", "server hello")
  feed.recordLog("error", "Server Exploded")
  feed.recordLog("warn", "browser warning", { source: "browser", page: "/x" })
  expect(feed.logs({ levels: ["error"] }).logs.map((l) => l.message)).toEqual(["Server Exploded"])
  expect(feed.logs({ source: "browser" }).logs[0]?.page).toBe("/x")
  expect(feed.logs({ grep: "exploded" }).logs).toHaveLength(1)
  expect(feed.logs({ limit: 1 }).logs.map((l) => l.message)).toEqual(["browser warning"])
  // Nothing empty is recorded.
  feed.recordLog("log", "")
  expect(feed.counts().logs).toBe(3)
})

test("the log ring evicts the oldest lines by count and reports how many it dropped", () => {
  const feed = createDevFeed({
    root: tempRoot(),
    env: {},
    persist: false,
    limits: { logs: 10, logBytes: 1_000_000 },
  })
  for (let i = 0; i < 25; i++) feed.recordLog("log", `line ${i}`)
  const result = feed.logs({ limit: 100 })
  expect(result.logs.length).toBeLessThanOrEqual(10)
  expect(result.logs.at(-1)?.message).toBe("line 24")
  expect(result.dropped).toBe(25 - result.logs.length)
})

test("the log ring also evicts by bytes", () => {
  const feed = createDevFeed({
    root: tempRoot(),
    env: {},
    persist: false,
    limits: { logs: 1000, logBytes: 100 },
  })
  for (let i = 0; i < 10; i++) feed.recordLog("log", `${i}`.repeat(30))
  expect(feed.logs({ limit: 1000 }).logs.length).toBeLessThan(10)
})

test("the error and request rings are bounded", () => {
  const feed = createDevFeed({
    root: tempRoot(),
    env: {},
    persist: false,
    limits: { errors: 3, requests: 2 },
  })
  for (let i = 0; i < 6; i++) feed.recordError(fail(`e${i}`), { category: "page" })
  expect(messages(feed.errors({ limit: 50 }).errors)).toEqual(["e3", "e4", "e5"])
  for (let i = 0; i < 4; i++) feed.startRequest(`r${i}`, "GET", "/")
  expect(feed.requests().requests.map((t) => t.requestId)).toEqual(["r2", "r3"])
})

test("secrets never enter the feed: messages, stacks, codeframes, request URLs, logs", () => {
  const root = tempRoot()
  const file = join(root, "loader.ts")
  writeFileSync(file, 'const key = "sk_live_0123456789abcdefABCDEF"\nthrow new Error("x")\n')
  const feed = feedAt(root, { DATABASE_PASSWORD: "hunter2-but-much-longer-value" })
  const error = new Error(
    "failed with sk_live_0123456789abcdefABCDEF and hunter2-but-much-longer-value",
  )
  error.stack = `Error: ${error.message}\n    at load (${file}:2:7)`
  const entry = feed.recordError(error, {
    category: "page",
    request: { method: "GET", url: "/cb?token=hunter2-but-much-longer-value" },
  })
  const text = JSON.stringify(entry)
  expect(text).not.toContain("sk_live_0123456789abcdefABCDEF")
  expect(text).not.toContain("hunter2-but-much-longer-value")
  expect(text).toContain("[redacted:DATABASE_PASSWORD]")
  expect(entry.diagnostic.codeframe?.lines[0]?.text).toContain("[redacted:Stripe secret key]")
  feed.recordLog("log", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123")
  expect(feed.logs().logs.at(-1)?.message).not.toContain("abcdefghijklmnopqrstuvwxyz0123")
})

test("long messages are capped, never dropped", () => {
  const feed = createDevFeed({ root: tempRoot(), env: {}, persist: false, limits: { message: 50 } })
  feed.recordLog("log", "x".repeat(500))
  const [line] = feed.logs().logs
  expect(line?.message.startsWith("x".repeat(50))).toBe(true)
  expect(line?.message).toContain("450 more chars")
})

test("persistence writes redacted NDJSON, errors synchronously, and survives a restart", () => {
  const root = tempRoot()
  const feed = createDevFeed({ root, env: { API_SECRET: "s3cr3t-value-that-is-long" } })
  feed.recordError(fail("crash s3cr3t-value-that-is-long"), { category: "process" })
  // Error writes are synchronous: readable before any flush.
  const raw = readFileSync(join(root, DEV_SERVER_LOG_FILE), "utf8")
  expect(raw).toContain('"t":"error"')
  expect(raw).not.toContain("s3cr3t-value-that-is-long")
  feed.recordLog("info", "buffered line")
  feed.close()
  // Writes after close are ignored, not appended late.
  feed.recordLog("info", "after close")
  const persisted = readPersistedFeed(root)
  expect(persisted.errors).toHaveLength(1)
  expect(persisted.logs.map((l) => l.message)).toEqual(["buffered line"])
})

test("the persisted log rotates instead of growing without bound", () => {
  const root = tempRoot()
  const feed = createDevFeed({ root, env: {} })
  const big = "y".repeat(7000)
  for (let i = 0; i < 400; i++) feed.recordLog("error", `${i} ${big}`)
  feed.close()
  const path = join(root, DEV_SERVER_LOG_FILE)
  expect(existsSync(`${path}.1`)).toBe(true)
  expect(statSync(path).size).toBeLessThanOrEqual(2 * 1024 * 1024 + 10_000)
  expect(readPersistedFeed(root, 5).logs.at(-1)?.message.startsWith("399 ")).toBe(true)
})

test("readPersistedFeed skips junk lines and a missing log", () => {
  const root = tempRoot()
  expect(readPersistedFeed(root)).toEqual({ errors: [], logs: [] })
  const feed = createDevFeed({ root, env: {} })
  feed.recordError(fail("a"), { category: "page" })
  feed.recordError(fail("a"), { category: "page" })
  feed.close()
  writeFileSync(
    join(root, DEV_SERVER_LOG_FILE),
    `not json\n42\n${readFileSync(join(root, DEV_SERVER_LOG_FILE), "utf8")}`,
  )
  const { errors } = readPersistedFeed(root)
  // Two writes of one id collapse to the latest.
  expect(errors).toHaveLength(1)
  expect(errors[0]?.count).toBe(2)
})

test("recordDevCrash persists the supervisor's view of a dead server", () => {
  const root = tempRoot()
  const file = join(root, "server.ts")
  writeFileSync(file, "one\ntwo\nthree\n")
  recordDevCrash(root, 1, `error: boom\n    at <anonymous> (${file}:2:3)\n`)
  const [crash] = readPersistedFeed(root).errors
  expect(crash?.category).toBe("process")
  expect(crash?.diagnostic.message).toContain("exited with code 1")
  expect(crash?.diagnostic.message).toContain("error: boom")
  expect(crash?.diagnostic.codeframe?.line).toBe(2)
})

test("discovery: atomic owner-only record, validated on read, removed only by its owner", () => {
  const root = tempRoot()
  const token = createDevToken()
  expect(token.length).toBeGreaterThanOrEqual(43)
  const record: DevServerRecord = {
    schema: 1,
    pid: process.pid,
    port: 4123,
    url: "http://localhost:4123",
    pipeline: "bun",
    root,
    startedAt: new Date().toISOString(),
    token,
  }
  writeDevServerRecord(root, record)
  const path = join(root, DEV_SERVER_RECORD_FILE)
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readDevServerRecord(root)).toEqual(record)
  removeDevServerRecord(root, createDevToken())
  expect(existsSync(path)).toBe(true)
  removeDevServerRecord(root, token)
  expect(existsSync(path)).toBe(false)
  expect(readDevServerRecord(root)).toBeUndefined()
})

test("a malformed or partial record reads as absent", () => {
  const root = tempRoot()
  writeDevServerRecord(root, {
    schema: 1,
    pid: 1,
    port: 70000,
    url: "x",
    pipeline: "bun",
    root,
    startedAt: "now",
    token: createDevToken(),
  })
  expect(readDevServerRecord(root)).toBeUndefined()
  writeFileSync(join(root, DEV_SERVER_RECORD_FILE), "{ not json")
  expect(readDevServerRecord(root)).toBeUndefined()
})

test("isProcessAlive tells a live pid from a dead one", () => {
  expect(isProcessAlive(process.pid)).toBe(true)
  expect(isProcessAlive(2 ** 22 + 12345)).toBe(false)
})

test("core's JSON log lines parse, and its unhandled-error line rebuilds the thrown error", () => {
  expect(parseCoreLogLine("plain text")).toBeUndefined()
  expect(parseCoreLogLine("{broken}")).toBeUndefined()
  expect(parseCoreLogLine('{"level":3}')).toBeUndefined()
  const entry = parseCoreLogLine(
    JSON.stringify({
      level: "error",
      message: "unhandled request error",
      method: "GET",
      path: "/api/x",
      name: "TypeError",
      detail: "x is undefined",
      stack: "TypeError: x is undefined\n    at handler (/app/backend/app.ts:3:9)",
    }),
  )
  expect(entry?.level).toBe("error")
  if (entry === undefined) throw new Error("expected a parsed core log line")
  const error = errorFromCoreLog(entry)
  expect(error?.name).toBe("TypeError")
  expect(error?.message).toBe("x is undefined")
  expect(error?.stack).toContain("backend/app.ts:3:9")
  expect(errorFromCoreLog({ level: "info", message: "listening" })).toBeUndefined()
  // `detail: "none"` logging keeps only the name.
  expect(errorFromCoreLog({ level: "error", message: "unhandled request error" })?.message).toBe(
    "Error",
  )
})

test("formatConsoleArgs matches the console's own formatting, uncolored", () => {
  expect(formatConsoleArgs(["a %s b %d", "x", 2])).toBe("a x b 2")
  expect(formatConsoleArgs([{ deep: { er: 1 } }])).toBe("{ deep: { er: 1 } }")
  const circular: Record<string, unknown> = {}
  circular.self = circular
  expect(formatConsoleArgs([circular])).toContain("Circular")
})

test("capture tees console and stream writes, tags the request, and restores on detach", () => {
  const seen: Array<{ level: string; message: string; requestId?: string }> = []
  const structured: string[] = []
  const originalLog = console.log
  const originalWrite = process.stderr.write
  const detach = installCapture({
    feedId: "f1",
    line: (level, message, request) => {
      const line: { level: string; message: string; requestId?: string } = { level, message }
      if (request !== undefined) line.requestId = request.requestId
      seen.push(line)
    },
    structured: (entry) => structured.push(entry.message),
  })
  const quiet = console.log
  try {
    // Silence the real output while asserting on the tee: the patched method still calls through.
    console.log("hello %s", "world")
    runWithDevRequest({ feedId: "f1", requestId: "r9", method: "GET", path: "/" }, () =>
      console.warn("inside"),
    )
    // Another feed's request does not reach this sink.
    runWithDevRequest({ feedId: "f2", requestId: "r1", method: "GET", path: "/" }, () =>
      console.error("elsewhere"),
    )
    process.stderr.write("partial ")
    process.stderr.write("line\n")
    process.stderr.write(`${JSON.stringify({ level: "warn", message: "core says" })}\n`)
    process.stdout.write(new TextEncoder().encode("\u001b[32mgreen\u001b[0m\n"))
  } finally {
    detach()
  }
  expect(quiet).not.toBe(originalLog)
  expect(console.log).toBe(originalLog)
  expect(process.stderr.write).toBe(originalWrite)
  expect(seen).toContainEqual({ level: "log", message: "hello world" })
  expect(seen).toContainEqual({ level: "warn", message: "inside", requestId: "r9" })
  expect(seen.some((s) => s.message === "elsewhere")).toBe(false)
  expect(seen).toContainEqual({ level: "error", message: "partial line" })
  expect(seen).toContainEqual({ level: "log", message: "green" })
  expect(structured).toEqual(["core says"])
})

test("capture is shared and reference-counted across sinks", () => {
  const original = console.info
  const a: string[] = []
  const b: string[] = []
  const detachA = installCapture({ feedId: "a", line: (_l, m) => a.push(m) })
  const detachB = installCapture({ feedId: "b", line: (_l, m) => b.push(m) })
  console.info("both")
  detachA()
  expect(console.info).not.toBe(original)
  console.info("only b")
  detachB()
  detachB()
  expect(console.info).toBe(original)
  expect(a).toEqual(["both"])
  expect(b).toEqual(["both", "only b"])
})

test("a throwing sink never breaks the console", () => {
  const detach = installCapture({
    feedId: "x",
    line: () => {
      throw new Error("sink bug")
    },
  })
  try {
    expect(() => console.debug("still fine")).not.toThrow()
  } finally {
    detach()
  }
})

test("the redactor scrubs each rule and leaves ordinary text alone", () => {
  const redact = createRedactor({
    SESSION_SECRET: "abcdefghijklmnopqrstuvwxyz012345",
    PUBLIC_SITE: "abcdefghijklmnopqrstuvwxyz012345-public",
    HOME: "/Users/someone",
  })
  expect(redact("short")).toBe("short")
  expect(redact("plain words about tokens and keys")).toBe("plain words about tokens and keys")
  expect(redact("v=abcdefghijklmnopqrstuvwxyz012345")).toBe("v=[redacted:SESSION_SECRET]")
  expect(redact(encodeURIComponent("abcdefghijklmnopqrstuvwxyz012345"))).toContain("[redacted:")
  expect(redact("home is /Users/someone")).toBe("home is /Users/someone")
  expect(redact("aws AKIAABCDEFGHIJKLMNOP")).toContain("[redacted:AWS access key id]")
  expect(
    redact("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv"),
  ).toBe("jwt [redacted:JWT]")
  expect(redact("postgres://app:pa55word-x@db:5432/x")).toBe("postgres://app:[redacted]@db:5432/x")
  expect(redact("postgres://user:password@db/x")).toBe("postgres://user:password@db/x")
  expect(redact("Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ=")).toBe("Authorization: [redacted]")
  expect(redact("{ cookie: 'session=abcdef0123456789' }")).toBe("{ cookie: '[redacted]' }")
  expect(
    redact("-----BEGIN PRIVATE KEY-----\n" + "A".repeat(80) + "\n-----END PRIVATE KEY-----"),
  ).toContain("[redacted:private key]")
})

test("a server frame in a file a dev plugin compiled is remapped to the line written; a browser one is not", () => {
  const root = tempRoot()
  const file = join(root, "routes", "settings.svelte")
  mkdirSync(join(root, "routes"))
  writeFileSync(file, "<script>\n  let prefs\n  prefs = JSON.parse(data)\n</script>\n")
  // Compiled line 9 (0-based 8), column 22 came from authored line 3 (0-based 2), column 10.
  const lines = Array.from({ length: 9 }, () => Int32Array.of())
  lines[8] = Int32Array.of(0, 0, 2, 10)
  ssrSourceMaps().set(file, {
    version: 3,
    sources: ["settings.svelte"],
    mappings: encodeMappings(lines),
  })
  try {
    const feed = feedAt(root)
    const failure = (): Error => {
      const err = new SyntaxError("JSON Parse error: Unexpected EOF")
      err.stack = `SyntaxError: JSON Parse error: Unexpected EOF\n    at Settings (${file}:9:23)`
      return err
    }
    const server = feed.recordError(failure(), { category: "page" })
    expect(server.diagnostic.codeframe?.line).toBe(3)
    expect(server.diagnostic.frames[0]?.raw).toBe(`at Settings (${file}:3:11)`)
    const browser = feed.recordError(failure(), { category: "browser", source: "browser" })
    expect(browser.diagnostic.frames[0]?.line).toBe(9)
    feed.close()
  } finally {
    ssrSourceMaps().delete(file)
  }
})
