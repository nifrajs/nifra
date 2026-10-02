/**
 * The `nifra_run` engine + its child-process entry. The MCP server spawns this file fresh on every
 * `nifra_run` call (`bun mcp-run.ts <cwd>`) so the project's CURRENT backend code is loaded - picking
 * up the agent's latest edits. {@link runBackend} is the pure-ish core (resolve entry → import → run),
 * exported so it's unit-testable in-process; the entry below wires it to stdin/stdout.
 */

import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { type AppLike, type RequestSpec, type RunResult, runApp } from "@nifrajs/runner"
import {
  captureInto,
  createDevFeed,
  type DevFeed,
  type DevLogLevel,
  runWithDevRequest,
} from "@nifrajs/web/dev-feed"
import type { Diagnostic } from "@nifrajs/web/diagnostic"
import { BACKEND_APP_FILE } from "./app-files.ts"
import {
  CHILD_INPUT_MAX_BYTES,
  CHILD_OUTPUT_MAX_BYTES,
  readBoundedLines,
  readBoundedStream,
  serializeBoundedJson,
} from "./mcp-io.ts"

const ENTRY_CANDIDATES = [BACKEND_APP_FILE, "app.ts", "src/app.ts"]

const errString = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err)

export async function loadBackend(
  cwd: string,
  entry?: string,
): Promise<{ app: AppLike } | { error: string }> {
  const candidates = entry && entry.length > 0 ? [entry] : ENTRY_CANDIDATES
  const found = candidates.map((c) => resolve(cwd, c)).find((p) => existsSync(p))
  if (!found) {
    return { error: `no backend entry found in ${cwd} (looked for ${candidates.join(", ")})` }
  }
  // The `entry` arg comes from MCP args; importing it executes it. Keep it inside the project root so a
  // crafted `entry` (`../../x`, an absolute path) can't run arbitrary modules outside the project.
  const root = realpathSync(resolve(cwd))
  let canonicalFound: string
  try {
    canonicalFound = realpathSync(found)
  } catch {
    return { error: `refusing to load an unresolved backend entry: ${entry}` }
  }
  const rel = relative(root, canonicalFound)
  // `isAbsolute` is not redundant with the `..` test: across two Windows drives `relative()` gives up
  // and returns the absolute target, which starts with neither `..` nor the separator - and then
  // `resolve(root, rel)` returns that same absolute path, so the round-trip check agrees with it too.
  if (
    rel.startsWith("..") ||
    rel === sep ||
    isAbsolute(rel) ||
    resolve(root, rel) !== canonicalFound
  ) {
    return { error: `refusing to load a backend entry outside the project root: ${entry}` }
  }

  let mod: Record<string, unknown>
  try {
    mod = (await import(pathToFileURL(found).href)) as Record<string, unknown>
  } catch (err) {
    return { error: errString(err) }
  }
  const app = (mod.app ?? mod.backend ?? mod.default) as AppLike | undefined
  if (!app || typeof app.fetch !== "function") {
    return {
      error: `${found} does not export a nifra app (expected \`app\`, \`backend\`, or default).`,
    }
  }
  return { app }
}

/**
 * Resolve the backend entry under `cwd`, import it, and run `requests` through its exported app. Never
 * throws - every failure (missing/invalid entry, import/compile/runtime error) becomes `{ error }`, so
 * the caller (and the agent) always gets actionable output. An import error here IS the failure the
 * agent needs to see and fix.
 */
export async function runBackend(
  cwd: string,
  requests: unknown,
  entry?: string,
): Promise<{ results: unknown } | { error: string }> {
  if (!Array.isArray(requests)) return { error: "expected { requests: [...] }" }

  const loaded = await loadBackend(cwd, entry)
  if ("error" in loaded) return loaded

  try {
    return { results: await runCaptured(cwd, loaded.app, requests) }
  } catch (err) {
    return { error: errString(err) }
  }
}

/** What `nifra_run` adds to the runner's result: what the app printed, and what failed, structured. */
export interface RunCapture {
  readonly logs?: ReadonlyArray<{ readonly level: DevLogLevel; readonly message: string }>
  readonly errors?: readonly Diagnostic[]
}

const MAX_LOGS_PER_REQUEST = 100

/**
 * Run `requests` one at a time, each inside its own request context, so what a handler logs - and
 * core's `unhandled request error` line behind a bare 500 - lands on the result of the request that
 * produced it, redacted, with the error as a Diagnostic (codeframe, cause, fix). Without this a 500 came
 * back as `internal_error` and the reason only ever reached a stderr nobody reads.
 */
export async function runCaptured(
  cwd: string,
  app: AppLike,
  requests: readonly unknown[],
): Promise<Array<RunResult & RunCapture>> {
  const feed = createDevFeed({ root: cwd, persist: false })
  const detach = captureInto(feed)
  const runs: Array<{ readonly requestId: string; readonly result: RunResult }> = []
  try {
    for (const [index, spec] of requests.entries()) {
      const requestId = `run${index + 1}`
      const [method, path] = describeSpec(spec)
      const [result] = await runWithDevRequest(
        { feedId: feed.id, requestId, method, path },
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: runApp validates each spec itself and reports a malformed one as that request's error.
        () => runApp(app, [spec as RequestSpec]),
      )
      if (result !== undefined) runs.push({ requestId, result })
    }
    // A line a handler scheduled for later (a promise continuation, a 0 ms timer) still lands.
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    detach()
  }
  return runs.map(({ requestId, result }) => withCapture(feed, requestId, result))
}

function describeSpec(spec: unknown): [string, string] {
  if (typeof spec !== "object" || spec === null) return ["GET", "/"]
  const method = "method" in spec && typeof spec.method === "string" ? spec.method : "GET"
  const path = "path" in spec && typeof spec.path === "string" ? spec.path : "/"
  return [method, path]
}

function withCapture(feed: DevFeed, requestId: string, result: RunResult): RunResult & RunCapture {
  if (result.error !== undefined) {
    const thrown = new Error(result.error.message)
    thrown.name = result.error.name
    if (result.error.stack !== undefined) thrown.stack = result.error.stack
    feed.recordError(thrown, { category: "api", requestId })
  }
  const capture: { -readonly [K in keyof RunCapture]: RunCapture[K] } = {}
  const logs = feed.logs({ requestId, limit: MAX_LOGS_PER_REQUEST }).logs
  if (logs.length > 0) capture.logs = logs.map(({ level, message }) => ({ level, message }))
  const errors = feed.errors({ requestId }).errors
  if (errors.length > 0) capture.errors = errors.map((entry) => entry.diagnostic)
  return { ...result, ...capture }
}

interface WorkerMessage {
  readonly id?: unknown
  readonly input?: { readonly requests?: unknown; readonly entry?: string }
}

function redirectConsoleToStderr(): void {
  const write = (level: string, args: unknown[]): void => {
    Bun.stderr.write(`[${level}] ${args.map((arg) => String(arg)).join(" ")}\n`)
  }
  console.debug = (...args: unknown[]) => write("debug", args)
  console.info = (...args: unknown[]) => write("info", args)
  console.log = (...args: unknown[]) => write("log", args)
  console.warn = (...args: unknown[]) => write("warn", args)
  console.error = (...args: unknown[]) => write("error", args)
}

function safeResponseId(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value
  if (typeof value === "string" && value.length <= 128) return value
  return null
}

/**
 * Keep stdout for the protocol. The app's console and any direct `process.stdout.write` go to stderr,
 * or a stray `console.log` in a handler would corrupt the JSON the parent reads. Returns the writer
 * that still reaches the real stdout.
 */
function reserveStdout(): (text: string) => void {
  redirectConsoleToStderr()
  const original: unknown = Reflect.get(process.stdout, "write")
  const write = typeof original === "function" ? original.bind(process.stdout) : undefined
  // Bound now, before any capture patches stderr: a redirected stdout line is captured once, as stdout.
  const toStderr = process.stderr.write.bind(process.stderr)
  Reflect.set(process.stdout, "write", (chunk: unknown, ...rest: unknown[]) =>
    Reflect.apply(toStderr, process.stderr, [chunk, ...rest]),
  )
  return (text) => {
    write?.(text)
  }
}

async function runWorker(cwd: string, protocol: (text: string) => void): Promise<void> {
  const apps = new Map<string, Promise<{ app: AppLike } | { error: string }>>()
  const send = (id: unknown, output: unknown): void => {
    const responseId = safeResponseId(id)
    const encoded = serializeBoundedJson({ id: responseId, output }, CHILD_OUTPUT_MAX_BYTES - 1)
    protocol(
      `${encoded ?? JSON.stringify({ id: responseId, output: { error: "worker output exceeded the size limit" } })}\n`,
    )
  }
  for await (const item of readBoundedLines(Bun.stdin.stream(), CHILD_INPUT_MAX_BYTES)) {
    if (item.kind === "too-large") {
      send(null, { error: `worker input exceeded ${CHILD_INPUT_MAX_BYTES} bytes` })
      continue
    }
    const line = item.text.trim()
    if (line === "") continue

    let message: unknown
    try {
      message = JSON.parse(line) as unknown
    } catch {
      send(null, { error: "invalid worker input: expected JSON line" })
      continue
    }
    const record =
      message !== null && typeof message === "object" && !Array.isArray(message)
        ? (message as WorkerMessage)
        : undefined
    const input =
      record?.input !== null && typeof record?.input === "object" && !Array.isArray(record.input)
        ? record.input
        : undefined
    const id = record?.id
    const requests = input?.requests
    const entry = input?.entry
    if (!Array.isArray(requests)) {
      send(id, { error: "expected { requests: [...] }" })
      continue
    }
    if (entry !== undefined && typeof entry !== "string") {
      send(id, { error: "entry must be a string" })
      continue
    }
    const key = entry ?? ""
    let loaded = apps.get(key)
    if (loaded === undefined) {
      loaded = loadBackend(cwd, entry)
      apps.set(key, loaded)
    }
    let app: Awaited<typeof loaded>
    try {
      app = await loaded
    } catch (err) {
      send(id, { error: errString(err) })
      continue
    }
    if ("error" in app) {
      send(id, app)
      continue
    }
    try {
      send(id, { results: await runCaptured(cwd, app.app, requests) })
    } catch (err) {
      send(id, { error: errString(err) })
    }
  }
}

// Child-process entry: read `{ requests, entry? }` from stdin, run, print JSON to stdout. Guarded so
// this only executes when run directly (not when imported by a test).
if (import.meta.main) {
  const cwd = process.argv[2] ?? process.cwd()
  const protocol = reserveStdout()
  if (process.argv.includes("--worker")) {
    await runWorker(cwd, protocol)
    process.exit(0)
  }
  let output: unknown
  const input = await readBoundedStream(Bun.stdin.stream(), CHILD_INPUT_MAX_BYTES)
  if (input.truncated) {
    output = { error: `input exceeded ${CHILD_INPUT_MAX_BYTES} bytes` }
  } else {
    try {
      const { requests, entry } = JSON.parse(input.text) as {
        requests: unknown
        entry?: string
      }
      output = await runBackend(cwd, requests, entry)
    } catch {
      output = { error: "invalid input: expected JSON { requests: [...] }" }
    }
  }
  protocol(
    serializeBoundedJson(output, CHILD_OUTPUT_MAX_BYTES, 2) ??
      JSON.stringify({ error: `output exceeded ${CHILD_OUTPUT_MAX_BYTES} bytes` }),
  )
}
