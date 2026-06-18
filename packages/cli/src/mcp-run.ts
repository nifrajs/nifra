/**
 * The `nifra_run` engine + its child-process entry. The MCP server spawns this file fresh on every
 * `nifra_run` call (`bun mcp-run.ts <cwd>`) so the project's CURRENT backend code is loaded — picking
 * up the agent's latest edits. {@link runBackend} is the pure-ish core (resolve entry → import → run),
 * exported so it's unit-testable in-process; the entry below wires it to stdin/stdout.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { type AppLike, runApp } from "@nifrajs/runner"

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
 * throws — every failure (missing/invalid entry, import/compile/runtime error) becomes `{ error }`, so
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

async function runWorker(cwd: string): Promise<void> {
  redirectConsoleToStderr()
  const apps = new Map<string, Promise<{ app: AppLike } | { error: string }>>()
  const decoder = new TextDecoder()
  let buffer = ""
  const send = (id: unknown, output: unknown): void => {
    process.stdout.write(`${JSON.stringify({ id, output })}\n`)
  }
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let nl = buffer.indexOf("\n")
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf("\n")
      if (line === "") continue

      let message: WorkerMessage
      try {
        message = JSON.parse(line) as WorkerMessage
      } catch {
        send(null, { error: "invalid worker input: expected JSON line" })
        continue
      }
      const requests = message.input?.requests
      const entry = message.input?.entry
      if (!Array.isArray(requests)) {
        send(message.id, { error: "expected { requests: [...] }" })
        continue
      }
      const key = entry ?? ""
      let loaded = apps.get(key)
      if (loaded === undefined) {
        loaded = loadBackend(cwd, entry)
        apps.set(key, loaded)
      }
      const app = await loaded
      if ("error" in app) {
        send(message.id, app)
        continue
      }
      try {
        send(message.id, {
          results: await runApp(app.app, requests as Parameters<typeof runApp>[1]),
        })
      } catch (err) {
        send(message.id, { error: errString(err) })
      }
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
  try {
    const { requests, entry } = JSON.parse(await Bun.stdin.text()) as {
      requests: unknown
      entry?: string
    }
    output = await runBackend(cwd, requests, entry)
  } catch {
    output = { error: "invalid input: expected JSON { requests: [...] }" }
  }
  process.stdout.write(JSON.stringify(output, null, 2))
}
