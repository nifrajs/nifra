/**
 * The `nifra_run` engine + its child-process entry. The MCP server spawns this file fresh on every
 * `nifra_run` call (`bun mcp-run.ts <cwd>`) so the project's CURRENT backend code is loaded - picking
 * up the agent's latest edits. {@link runBackend} is the pure-ish core (resolve entry → import → run),
 * exported so it's unit-testable in-process; the entry below wires it to stdin/stdout.
 */

import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { type AppLike, runApp } from "@nifrajs/runner"
import {
  CHILD_INPUT_MAX_BYTES,
  CHILD_OUTPUT_MAX_BYTES,
  readBoundedLines,
  readBoundedStream,
  serializeBoundedJson,
} from "./mcp-io.ts"

const ENTRY_CANDIDATES = ["backend.ts", "app.ts", "src/backend.ts", "src/app.ts"]

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
    return { results: await runApp(loaded.app, requests as Parameters<typeof runApp>[1]) }
  } catch (err) {
    return { error: errString(err) }
  }
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

async function runWorker(cwd: string): Promise<void> {
  redirectConsoleToStderr()
  const apps = new Map<string, Promise<{ app: AppLike } | { error: string }>>()
  const send = (id: unknown, output: unknown): void => {
    const responseId = safeResponseId(id)
    const encoded = serializeBoundedJson({ id: responseId, output }, CHILD_OUTPUT_MAX_BYTES - 1)
    process.stdout.write(
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
      send(id, {
        results: await runApp(app.app, requests as Parameters<typeof runApp>[1]),
      })
    } catch (err) {
      send(id, { error: errString(err) })
    }
  }
}

// Child-process entry: read `{ requests, entry? }` from stdin, run, print JSON to stdout. Guarded so
// this only executes when run directly (not when imported by a test).
if (import.meta.main) {
  const cwd = process.argv[2] ?? process.cwd()
  if (process.argv.includes("--worker")) {
    await runWorker(cwd)
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
  process.stdout.write(
    serializeBoundedJson(output, CHILD_OUTPUT_MAX_BYTES, 2) ??
      JSON.stringify({ error: `output exceeded ${CHILD_OUTPUT_MAX_BYTES} bytes` }),
  )
}
