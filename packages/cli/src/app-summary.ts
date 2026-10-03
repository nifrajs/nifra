/**
 * `nifra mcp`'s view of an app, loaded without evaluating `nifra.config.ts` in its own process.
 *
 * The config declares `devDatabase` and may read secrets from `.env`, and the MCP server is a
 * long-lived process an agent drives, so the config runs only in short-lived subprocesses:
 * `app-summary-child.ts` for what this module returns, `db-child.ts` for the database tools. The
 * backend (`backend/app.ts`) still loads here, since the app's own tools, resources and prompts are
 * read from it.
 */

import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { AppConfigFacts, AppSummaryRequest } from "./app-summary-child.ts"
import {
  type AppSummary,
  importBackend,
  type LoadAppOptions,
  monorepoConfigPath,
  type NifraMonorepoConfig,
  resolveAppConfig,
} from "./load.ts"
import {
  CHILD_OUTPUT_MAX_BYTES,
  CHILD_TIMEOUT_MS,
  readBoundedLines,
  readBoundedStream,
} from "./mcp-io.ts"

interface ChildFailure {
  readonly ok: false
  readonly message: string
}

function childPath(): string {
  return fileURLToPath(new URL(import.meta.url)).replace(
    /app-summary\.(ts|js)$/,
    "app-summary-child.$1",
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function acceptConfig(answer: Record<string, unknown>): AppConfigFacts | undefined {
  const { config } = answer
  if (!isRecord(config) || typeof config.configPath !== "string") return undefined
  const { framework, resolvedPlugins } = config
  if (!isRecord(framework) || typeof framework.clientModule !== "string") return undefined
  if (
    !isRecord(resolvedPlugins) ||
    !Array.isArray(resolvedPlugins.vitePlugins) ||
    !Array.isArray(resolvedPlugins.clientPlugins) ||
    !Array.isArray(resolvedPlugins.serverPlugins)
  )
    return undefined
  return config as unknown as AppConfigFacts
}

function acceptApps(answer: Record<string, unknown>): { apps: Record<string, string> | null } {
  const { apps } = answer
  if (!isRecord(apps)) return { apps: null }
  const entries = Object.entries(apps).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  )
  return { apps: Object.fromEntries(entries) }
}

/**
 * Ask a fresh subprocess to evaluate the config in `cwd`, killing it after {@link CHILD_TIMEOUT_MS}.
 * `accept` reads a successful answer; a crash, a timeout or no answer comes back as a failure.
 */
async function askChild<T>(
  cwd: string,
  kind: AppSummaryRequest["kind"],
  accept: (answer: Record<string, unknown>) => T | undefined,
): Promise<T | ChildFailure> {
  const token = randomUUID()
  const proc = Bun.spawn([process.execPath, childPath(), cwd], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGKILL")
  }, CHILD_TIMEOUT_MS)
  try {
    proc.stdin.write(JSON.stringify({ kind, token }))
    await proc.stdin.end()
    const stderr = readBoundedStream(proc.stderr, 16 * 1024)
    let answer: T | ChildFailure | undefined
    for await (const item of readBoundedLines(proc.stdout, CHILD_OUTPUT_MAX_BYTES)) {
      if (answer !== undefined || item.kind !== "line" || !item.text.startsWith(`${token} `))
        continue
      let value: unknown
      try {
        value = JSON.parse(item.text.slice(token.length + 1))
      } catch {
        continue
      }
      if (!isRecord(value)) continue
      if (value.ok === false && typeof value.message === "string") {
        answer = { ok: false, message: value.message }
      } else if (value.ok === true) {
        answer = accept(value)
      }
    }
    const [errors] = await Promise.all([stderr, proc.exited])
    if (answer !== undefined) return answer
    if (timedOut) {
      return {
        ok: false,
        message: `[nifra] the app config in ${cwd} did not load within ${CHILD_TIMEOUT_MS / 1000}s and its process was killed`,
      }
    }
    const tail = errors.text.trim().slice(-600)
    const how = proc.signalCode === null ? `with code ${proc.exitCode}` : `on ${proc.signalCode}`
    return {
      ok: false,
      message: `[nifra] the process loading the app config in ${cwd} exited ${how} before answering${tail === "" ? "" : `: ${tail}`}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

const isFailure = (value: unknown): value is ChildFailure =>
  isRecord(value) && value.ok === false && typeof value.message === "string"

/**
 * `loadApp`, with `nifra.config.ts` evaluated in a fresh subprocess and only its serializable
 * fields brought back. The checks `loadApp` makes before importing run here first, so a missing
 * config or `routes/` throws the same error without a subprocess; a config that fails to load throws
 * `loadApp`'s message.
 */
export async function loadAppSummary(
  cwd: string,
  outDirName = "dist",
  options: LoadAppOptions = {},
): Promise<AppSummary> {
  resolveAppConfig(cwd)
  const config = await askChild(cwd, "app", acceptConfig)
  if (isFailure(config)) throw new Error(config.message)
  return {
    cwd,
    configPath: config.configPath,
    routesDir: resolve(cwd, "routes"),
    outDir: resolve(cwd, outDirName),
    framework: config.framework,
    resolvedPlugins: config.resolvedPlugins,
    backend: await importBackend(cwd, options.importQuery),
  }
}

/**
 * `detectMonorepo`, with the root config evaluated in a fresh subprocess. A config that fails
 * to load does not make a monorepo root, as there.
 */
export async function detectMonorepoApps(cwd: string): Promise<NifraMonorepoConfig | null> {
  if (monorepoConfigPath(cwd) === null) return null
  const found = await askChild(cwd, "monorepo", acceptApps)
  return isFailure(found) || found.apps === null ? null : { apps: found.apps }
}
