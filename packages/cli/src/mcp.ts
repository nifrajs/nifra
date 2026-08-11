/**
 * `nifra mcp` - a Model Context Protocol server (stdio) that lets a coding agent (Claude, Cursor, …)
 * act on a nifra project, not just read about it:
 *
 *   - `nifra_context` - this project's API routes + page routes + conventions (see {@link describeProject}).
 *   - `nifra_run`     - run HTTP requests through the project's backend and return structured results
 *     (status, body, errors). The write → run → see-the-failure → fix loop, powered by `@nifrajs/runner`.
 *     Each call runs the backend in a FRESH subprocess, so it reflects the agent's latest edits.
 *   - `nifra_render`  - SSR a page route through the project's web app; returns the rendered HTML (the
 *     page half of `nifra_run`). Fresh subprocess per call; no build needed.
 *   - `nifra_ws`      - verify a WebSocket route with a real Bun WebSocket round-trip.
 *   - `nifra_docs`    - keyword-search the framework docs; returns only the matching sections.
 *   - `nifra_example` - a verified, copy-pasteable snippet for a task (typechecked against the live API,
 *     so it can't hallucinate a drifted nifra API).
 *   - `nifra_learn`   - the guided, ordered path to build a nifra app end to end (create → deploy), each
 *     step naming the tool that emits the correct artifact and how to verify it.
 *   - `nifra_scaffold`- map a URL path to the correct `routes/` file + a contract-correct page stub.
 *   - `nifra_check`   - the drift gate (typecheck + lints, each with a structured fix), for an agent to fix against.
 *   - `nifra_assure`  - route classification + enforcement-evidence gate.
 *   - `nifra_levels`  - the cumulative verification ladder (L0 contract → L4 invariants): what the
 *     project actually proves, and why each level it misses does not hold.
 *   - `nifra_doctor`  - package.json dependency drift detector, with safe local-version auto-fix.
 *   - `nifra_explain` - resolve an error (pasted, or the dev server's last) into a structured
 *     diagnostic: stable code, a codeframe in the user's source, and the recognised cause + fix.
 *   - `nifra_inspect` - read the running dev server's recent request traces (method/path/status/
 *     duration/ISR) from the DevTools plugin: what your requests ACTUALLY did, not a guess.
 *
 * Wire it into a client (e.g. Claude Desktop / Cursor) as: command `nifra`, args `["mcp"]` (or
 * `["mcp", "<dir>"]` to pin the project directory explicitly). The server does NOT silently trust its
 * spawn directory: the root is resolved via `./mcp-root.ts` (marker walk-up, the client's MCP `roots`,
 * fail-closed tools when no nifra project is found) and announced in `initialize` + on every project
 * tool result. The protocol is hand-rolled (newline-delimited JSON-RPC 2.0 over stdio), including
 * standard MCP progress notifications and request cancellation - no SDK dependency, the same
 * minimal-surface choice as the rest of nifra. The pure dispatch lives in `./mcp-protocol.ts`; this
 * module is the I/O shell (stdin loop, tool wiring, the run subprocess).
 */

import { readFile, stat } from "node:fs/promises"
import { basename, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { type ReflectedRoute, reflectRoutes } from "@nifrajs/core/reflection"
import { Glob } from "bun"
import { collectContractProof } from "./contract-proof.ts"
import { loadDocsCorpus } from "./docs-search.ts"
import { loadExamplesCorpus } from "./examples.ts"
import { describeProject } from "./introspect.ts"
import type { LoadAppOptions, LoadedApp } from "./load.ts"
import { detectMonorepo, loadMonorepoApps } from "./load.ts"
import { docsTools } from "./mcp-docs-tools.ts"
import {
  createMcpProtocolState,
  handleRpc,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpContentBlock,
  type McpPrompt,
  type McpPromptMessage,
  type McpResource,
  type McpServerFeatures,
  type McpTool,
  type McpToolContext,
  type McpToolResult,
  rpcError,
} from "./mcp-protocol.ts"
import {
  applyClientRoots,
  detectToolingDrift,
  driftNote,
  type McpRootVerdict,
  pathsFromRootsResult,
  resolveRootState,
  rootInstructions,
  rootVerdict,
  type ToolingDrift,
} from "./mcp-root.ts"
import { loadTypesCorpus } from "./types-search.ts"
import { collectProjectWorkGraph } from "./work-graph.ts"

/** Path to a sibling child entry (`mcp-run` / `mcp-render` / `mcp-ws`), resolved next to this module (`.ts` in
 * dev, `.js` once built). Each runs in a FRESH subprocess per call so the project's current code loads. */
function childPath(name: "mcp-run" | "mcp-render" | "mcp-ws"): string {
  return fileURLToPath(new URL(import.meta.url)).replace(/mcp\.(ts|js)$/, `${name}.$1`)
}

/** Spawn `bun <child> <cwd>`, pipe `input` to its stdin, return its stdout (or a stderr-backed error). */
/**
 * How long a child gets before it is killed.
 *
 * A child loads the app, which runs its module side effects - a database pool, a Redis client, a
 * metrics interval. Any of those keeps the child's event loop alive after the work is done, and the
 * parent is sitting in `await proc.exited`. The children now exit explicitly, so this is the backstop
 * rather than the fix: without it a single wedged child blocks an agent indefinitely, and the caller
 * has no way to tell "still working" from "never returning".
 *
 * Generous enough for a cold start that compiles route modules, short enough that a hang is reported
 * within one attention span rather than after minutes of polling.
 */
const CHILD_TIMEOUT_MS = 30_000

/** Local dev-tool reads are intentionally bounded: MCP runs in an agent process and must not hang on or
 * buffer an unrelated loopback service just because a caller supplied its port. */
export const LOCAL_TOOL_FETCH_TIMEOUT_MS = 2_000
export const LOCAL_TOOL_MAX_RESPONSE_BYTES = 1_048_576

/** Accept only a concrete TCP port. Port 0 (bind-any-free-port) is not a valid read target. */
export function validateLocalPort(port: unknown): number | undefined {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined
}

/** Read a dev-tool response without allowing an untrusted localhost service to allocate unbounded memory. */
export async function readBoundedResponse(
  response: Response,
  maxBytes = LOCAL_TOOL_MAX_RESPONSE_BYTES,
): Promise<string> {
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxBytes)
      throw new Error("response exceeded the size limit")
  }
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error("response exceeded the size limit")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

const notNifraResponse = (service: string): string =>
  JSON.stringify(
    {
      code: "NIFRA_NOT_DEV_SERVER",
      message: `The service on this port is not a Nifra ${service} endpoint.`,
    },
    null,
    2,
  )

const timeoutMessage = (label: string, ms: number): string =>
  `${label} timed out after ${ms / 1000}s and was terminated.\n` +
  `The app was loaded but the process did not finish. Most often this is a module-level side effect ` +
  `that keeps the event loop alive (a database pool, a Redis client, an interval) opened during import ` +
  `rather than lazily. Check for top-level connections in the app entry or anything it imports.`

async function spawnChild(
  child: "mcp-run" | "mcp-render" | "mcp-ws",
  cwd: string,
  input: unknown,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return `${label} cancelled before it started.`
  const proc = Bun.spawn(["bun", childPath(child), cwd], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const abort = (): void => proc.kill()
  signal?.addEventListener("abort", abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, CHILD_TIMEOUT_MS)
  try {
    proc.stdin.write(JSON.stringify(input))
    await proc.stdin.end()
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (signal?.aborted) {
      const reason = typeof signal.reason === "string" ? `: ${signal.reason}` : ""
      return `${label} cancelled${reason}.`
    }
    // A killed child may still have flushed a complete result before the timer fired; prefer real
    // output over the timeout message so a slow-but-successful render is not reported as a failure.
    const text = out.trim()
    if (timedOut && text === "") return timeoutMessage(label, CHILD_TIMEOUT_MS)
    return text || `${label} failed:\n${err.trim() || "(no output)"}`
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

const WARM_RUN_GLOB = new Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json}")
const WARM_RUN_IGNORED =
  /(^|\/)(node_modules|dist(-[a-z0-9]+)?|build|\.nifra|\.git|\.wrangler|coverage)\//
const WARM_RUN_EXTRA_FILES = ["bun.lock", "bun.lockb"] as const

async function warmRunFingerprint(cwd: string): Promise<string> {
  const parts: string[] = []
  for await (const rel of WARM_RUN_GLOB.scan({ cwd, dot: false })) {
    if (WARM_RUN_IGNORED.test(rel)) continue
    try {
      const s = await stat(resolve(cwd, rel))
      if (s.isFile()) parts.push(`${rel}:${s.mtimeMs}:${s.size}`)
    } catch {
      // A file can disappear while an agent is editing. The next call will rescan the settled tree.
    }
  }
  for (const rel of WARM_RUN_EXTRA_FILES) {
    parts.push(`${rel}:${await fileFingerprint(resolve(cwd, rel))}`)
  }
  return cacheToken(parts.sort().join("|"))
}

function boundedAppend(current: string, next: string, max = 12_000): string {
  const combined = `${current}${next}`
  return combined.length <= max ? combined : combined.slice(combined.length - max)
}

type PipeSubprocess = ReturnType<typeof Bun.spawn> & {
  readonly stdin: { write(input: string | Uint8Array): unknown }
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
}

/** A persistent `mcp-run`/`mcp-render` `--worker` subprocess: the backend/web app is loaded ONCE and
 * reused across newline-delimited `{ id, input }` requests, replying `{ id, output }`. The same machinery
 * powers both `nifra_run warm` and `nifra_render warm` - `child` selects which engine, `label` shapes the
 * cancellation message. The owning handler ({@link createWarmHandler}) fingerprints the source tree and
 * replaces the worker when a file changes, so warm reuse never serves a stale result. Exported for the
 * concurrency test that proves a single per-request cancel doesn't tear down the shared worker. */
export class WarmWorker {
  private readonly proc: PipeSubprocess
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (text: string) => void
      readonly reject: (err: Error) => void
      readonly cleanup: () => void
    }
  >()
  private stdoutBuffer = ""
  private stderrBuffer = ""
  private nextId = 0
  private closed = false

  constructor(
    child: "mcp-run" | "mcp-render",
    cwd: string,
    readonly fingerprint: string,
    private readonly label: string,
  ) {
    this.proc = Bun.spawn(["bun", childPath(child), cwd, "--worker"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as PipeSubprocess
    void this.readStdout()
    void this.readStderr()
    void this.proc.exited.then((code) => {
      this.closed = true
      const err = new Error(
        `warm ${this.label} worker exited (${code})${this.stderrBuffer ? `:\n${this.stderrBuffer}` : ""}`,
      )
      for (const pending of this.pending.values()) {
        pending.cleanup()
        pending.reject(err)
      }
      this.pending.clear()
    })
  }

  stop(): void {
    if (!this.closed) this.proc.kill()
  }

  async request(input: unknown, signal?: AbortSignal): Promise<string> {
    if (this.closed) throw new Error(`warm ${this.label} worker is closed`)
    if (signal?.aborted) return `${this.label} cancelled before it started.`
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        // Per-request cancel: drop just THIS id and resolve its cancellation. The worker is shared
        // across concurrent requests (`pending` is id-keyed for exactly this reason), so killing the
        // process here would reject every OTHER in-flight request via the `exited` handler and force a
        // cold rebuild. Leave it hot - `createWarmHandler` already replaces it on file change.
        this.pending.delete(id)
        clearTimeout(timer)
        const reason = typeof signal?.reason === "string" ? `: ${signal.reason}` : ""
        resolve(`${this.label} cancelled${reason}.`)
      }
      // Same backstop as the cold path: a worker wedged mid-request would otherwise leave this
      // promise unsettled forever. Drop the id and replace the worker - unlike a per-request cancel,
      // a timeout means the worker itself is suspect, so the next call should start from a fresh one.
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        signal?.removeEventListener("abort", abort)
        this.stop()
        resolve(timeoutMessage(this.label, CHILD_TIMEOUT_MS))
      }, CHILD_TIMEOUT_MS)
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
      }
      signal?.addEventListener("abort", abort, { once: true })
      this.pending.set(id, { resolve, reject, cleanup })
      try {
        this.proc.stdin.write(`${JSON.stringify({ id, input })}\n`)
      } catch (err) {
        this.pending.delete(id)
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder()
    const reader = this.proc.stdout.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      this.stdoutBuffer += decoder.decode(value, { stream: true })
      let nl = this.stdoutBuffer.indexOf("\n")
      while (nl !== -1) {
        const line = this.stdoutBuffer.slice(0, nl).trim()
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1)
        nl = this.stdoutBuffer.indexOf("\n")
        if (line !== "") this.handleLine(line)
      }
    }
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder()
    const reader = this.proc.stderr.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      this.stderrBuffer = boundedAppend(this.stderrBuffer, decoder.decode(value, { stream: true }))
    }
  }

  private handleLine(line: string): void {
    let message: { id?: unknown; output?: unknown }
    try {
      message = JSON.parse(line) as { id?: unknown; output?: unknown }
    } catch {
      this.stderrBuffer = boundedAppend(
        this.stderrBuffer,
        `invalid warm ${this.label} worker line: ${line}\n`,
      )
      return
    }
    if (typeof message.id !== "number") return
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    pending.cleanup()
    pending.resolve(JSON.stringify(message.output, null, 2))
  }
}

/** A warm handler that reuses a hot {@link WarmWorker} across calls and falls back to a one-shot fresh
 * subprocess on any worker failure. Shared by `nifra_run` (`child: "mcp-run"`, `label: "run"`) and
 * `nifra_render` (`child: "mcp-render"`, `label: "render"`) - the only differences are the engine and the
 * message label, so there's a single source for the reuse + auto-restart-on-file-change logic. */
function createWarmHandler(
  child: "mcp-run" | "mcp-render",
  cwd: string,
  label: string,
): (input: unknown, signal?: AbortSignal) => Promise<string> {
  let worker: WarmWorker | undefined
  return async (input, signal) => {
    const fingerprint = await warmRunFingerprint(cwd)
    if (worker === undefined || worker.fingerprint !== fingerprint) {
      worker?.stop()
      worker = new WarmWorker(child, cwd, fingerprint, label)
    }
    try {
      return await worker.request(input, signal)
    } catch {
      worker.stop()
      worker = undefined
      if (signal?.aborted) {
        const reason = typeof signal.reason === "string" ? `: ${signal.reason}` : ""
        return `${label} cancelled${reason}.`
      }
      return spawnChild(child, cwd, input, label, signal)
    }
  }
}

/** The `nifra_run` handler: run requests through the project's CURRENT backend, return structured results. */
async function runHandler(
  cwd: string,
  args: Record<string, unknown>,
  context: McpToolContext,
  warmRun: (input: unknown, signal?: AbortSignal) => Promise<string>,
): Promise<string> {
  const requests = Array.isArray(args.requests) ? args.requests : []
  if (requests.length === 0) {
    return 'No requests provided. Pass { "requests": [{ "path": "/..." }] }.'
  }
  const input = { requests, entry: args.entry }
  if ((args as { warm?: boolean }).warm === true) {
    context.reportProgress(0.2, 1)
    return warmRun(input, context.signal)
  }
  return spawnChild("mcp-run", cwd, input, "run", context.signal)
}

/** The `nifra_render` handler: SSR page routes through the project's CURRENT web app, return the HTML.
 * By default a fresh subprocess loads the current code each call; `warm:true` reuses a hot worker (like
 * `nifra_run`) that auto-restarts when a source file changes. */
async function renderHandler(
  cwd: string,
  args: Record<string, unknown>,
  context: McpToolContext,
  warmRender: (input: unknown, signal?: AbortSignal) => Promise<string>,
): Promise<string> {
  const requests = Array.isArray(args.requests) ? args.requests : []
  if (requests.length === 0) {
    return 'No requests provided. Pass { "requests": [{ "path": "/..." }] }.'
  }
  const input = { requests }
  if ((args as { warm?: boolean }).warm === true) {
    context.reportProgress(0.2, 1)
    return warmRender(input, context.signal)
  }
  return spawnChild("mcp-render", cwd, input, "render", context.signal)
}

/** The `nifra_ws` handler: verify WebSocket routes through a fresh app subprocess. */
async function wsHandler(
  cwd: string,
  args: Record<string, unknown>,
  context: McpToolContext,
): Promise<string> {
  return spawnChild("mcp-ws", cwd, args, "websocket", context.signal)
}

function openApiFormat(args: Record<string, unknown>): "json" | "yaml" {
  const format = args.format
  return format === "yaml" ? "yaml" : "json"
}

type LoadAppForCache = (
  cwd: string,
  outDirName?: string,
  options?: LoadAppOptions,
) => Promise<LoadedApp>

export interface CachedAppLoaderOptions {
  readonly loadApp?: LoadAppForCache
  readonly fingerprint?: (cwd: string) => Promise<string>
}

const APP_FINGERPRINT_FILES = ["nifra.config.ts", "framework.ts", "backend.ts"] as const

function cacheToken(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `mcp=${(hash >>> 0).toString(36)}`
}

async function fileFingerprint(path: string): Promise<string> {
  try {
    const s = await stat(path)
    return `${s.mtimeMs}:${s.size}`
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") {
      return "missing"
    }
    throw err
  }
}

async function appFingerprint(cwd: string): Promise<string> {
  return (
    await Promise.all(
      APP_FINGERPRINT_FILES.map(
        async (file) => `${file}:${await fileFingerprint(resolve(cwd, file))}`,
      ),
    )
  ).join("|")
}

/** Cache LoadedApp inside one MCP server process, invalidating when config/backend mtimes change. */
export function createCachedAppLoader(
  cwd: string,
  options: CachedAppLoaderOptions = {},
): (outDirName?: string) => Promise<LoadedApp> {
  const loadAppCached =
    options.loadApp ??
    (async (root: string, outDirName?: string, loadOptions?: LoadAppOptions) => {
      const mod = await import("./load.ts")
      return mod.loadApp(root, outDirName, loadOptions)
    })
  const fingerprint = options.fingerprint ?? appFingerprint
  let cached:
    | {
        readonly outDirName: string
        readonly fingerprint: string
        readonly app: LoadedApp
      }
    | undefined

  return async (outDirName = "dist") => {
    const nextFingerprint = await fingerprint(cwd)
    if (
      cached !== undefined &&
      cached.outDirName === outDirName &&
      cached.fingerprint === nextFingerprint
    ) {
      return cached.app
    }
    const app = await loadAppCached(cwd, outDirName, {
      importQuery: cacheToken(nextFingerprint),
    })
    cached = { outDirName, fingerprint: nextFingerprint, app }
    return app
  }
}

async function openApiHandler(
  args: Record<string, unknown>,
  loadAppCached: (outDirName?: string) => Promise<LoadedApp>,
): Promise<string> {
  const { renderOpenApi } = await import("./openapi-tool.ts")
  const pathPrefix = typeof args.path === "string" ? args.path : undefined
  return renderOpenApi(await loadAppCached(), openApiFormat(args), pathPrefix)
}

async function readProjectFile(
  cwd: string,
  relativeFile: string,
  maxChars: number,
): Promise<string> {
  const target = resolve(cwd, relativeFile)
  const root = resolve(cwd)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`refusing to read outside project root: ${relativeFile}`)
  }
  try {
    const text = await readFile(target, "utf8")
    return text.length <= maxChars
      ? text
      : `${text.slice(0, maxChars)}\n…(trimmed; read ${relativeFile} directly for the rest)`
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") {
      return `No ${relativeFile} found in ${basename(cwd)}.`
    }
    throw err
  }
}

function promptText(
  text: string,
): readonly [
  { readonly role: "user"; readonly content: { readonly type: "text"; readonly text: string } },
] {
  return [{ role: "user", content: { type: "text", text } }]
}

export function projectResources(
  cwd: string,
  loadAppCached: (outDirName?: string) => Promise<LoadedApp> = createCachedAppLoader(cwd),
): McpResource[] {
  return [
    {
      uri: "nifra://routes",
      name: "API routes",
      description:
        "Structured API routes with typed-client calls and compact request/response shapes.",
      mimeType: "application/json",
      read: async () => {
        const { routesToJson } = await import("./introspect.ts")
        return { text: JSON.stringify(routesToJson(await loadAppCached()), null, 2) }
      },
    },
    {
      uri: "nifra://openapi",
      name: "OpenAPI 3.1",
      description: "OpenAPI document generated from backend.ts using @nifrajs/schema.",
      mimeType: "application/json",
      read: async () => ({ text: await openApiHandler({ format: "json" }, loadAppCached) }),
    },
    {
      uri: "nifra://package-json",
      name: "package.json",
      description: "Project package metadata and scripts.",
      mimeType: "application/json",
      read: async () => ({ text: await readProjectFile(cwd, "package.json", 40_000) }),
    },
    {
      uri: "nifra://agents-md",
      name: "AGENTS.md",
      description: "Repository-specific agent instructions if the project has them.",
      mimeType: "text/markdown",
      read: async () => ({ text: await readProjectFile(cwd, "AGENTS.md", 40_000) }),
    },
  ]
}

export function projectPrompts(): McpPrompt[] {
  return [
    {
      name: "nifra_new_route",
      description:
        "Implement a new file route with the right routes/ filename, examples, and checks.",
      arguments: [
        { name: "path", description: 'URL path, e.g. "/users/:id".', required: true },
        { name: "goal", description: "What the page should do.", required: false },
      ],
      handler: async (args) =>
        promptText(
          [
            `Create a nifra page route for ${JSON.stringify(args.path ?? "/new-route")}.`,
            args.goal ? `Goal: ${String(args.goal)}` : undefined,
            'Use `nifra_context` with `{ kind: "pages" }`, then `nifra_scaffold` for the exact file path.',
            "If the stub is not writable for this framework, call `nifra_example` for a verified page/loader example before editing.",
            "Verify with `nifra_render` for the route and finish with `nifra_check`.",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
    },
    {
      name: "nifra_add_endpoint",
      description:
        "Add or update a backend endpoint with schemas, typed-client usage, and verification.",
      arguments: [
        { name: "method", description: "HTTP method.", required: true },
        { name: "path", description: 'API path, e.g. "/users/:id".', required: true },
        { name: "goal", description: "What the endpoint should do.", required: false },
      ],
      handler: async (args) =>
        promptText(
          [
            `Add a nifra backend endpoint: ${String(args.method ?? "GET").toUpperCase()} ${String(args.path ?? "/api")}.`,
            args.goal ? `Goal: ${String(args.goal)}` : undefined,
            "Read `nifra://routes` or call `nifra_routes` first so the new route fits the existing API shape.",
            "Use route schemas for untrusted body/query input and declare `response` when the frontend consumes the shape.",
            "Verify behavior with `nifra_run`, then run `nifra_check` and `nifra_test` for the touched area.",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
    },
    {
      name: "nifra_debug_drift",
      description:
        "Debug frontend/backend contract drift using the typed client and checker output.",
      arguments: [
        { name: "symptom", description: "The error or behavior to investigate.", required: false },
      ],
      handler: async (args) =>
        promptText(
          [
            "Debug nifra contract drift.",
            args.symptom ? `Symptom: ${String(args.symptom)}` : undefined,
            "Start with `nifra_check`; use each diagnostic as the source of truth.",
            "Read `nifra://routes` for the exact typed-client calls and compact body/query/response shapes.",
            "Prefer `client<typeof app>` over hand-rolled internal `fetch`. Verify fixed endpoints with `nifra_run`.",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
    },
  ]
}

export function projectFeatures(
  cwd: string,
  loadAppCached: (outDirName?: string) => Promise<LoadedApp> = createCachedAppLoader(cwd),
): McpServerFeatures {
  return { resources: projectResources(cwd, loadAppCached), prompts: projectPrompts() }
}

/**
 * Resolve an optional `dir` tool argument - a subdirectory of the project root the caller wants to scope a
 * check/test to (e.g. `nifra check` on `app/` when the MCP server's root is a monorepo). Returns the
 * absolute target, or `null` if `dir` escapes the root (a path-traversal guard: no `..` out, no absolute
 * path elsewhere). `undefined`/empty → the root itself.
 */
export function resolveProjectDir(root: string, dir: string | undefined): string | null {
  if (dir === undefined || dir === "") return root
  const target = resolve(root, dir)
  return target === root || target.startsWith(root + sep) ? target : null
}

/** Consistent error string for a `dir` that escapes the project root. */
function dirError(dir: string | undefined): string {
  return JSON.stringify(
    { ok: false, error: `dir must be a subdirectory of the project root - "${dir}" escapes it.` },
    null,
    2,
  )
}

/** Build the project-scoped tools for `cwd`. */
export function projectTools(
  cwd: string,
  loadAppCached: (outDirName?: string) => Promise<LoadedApp> = createCachedAppLoader(cwd),
): McpTool[] {
  const warmRun = createWarmHandler("mcp-run", cwd, "run")
  const warmRender = createWarmHandler("mcp-render", cwd, "render")
  return [
    {
      name: "nifra_contract_proof",
      description:
        "Compare the current route contract with its snapshot and join each changed route to its route-assurance and capability evidence. Returns hasBreaking as the gate. The typed-contract check is lazy and runs only when check is true.",
      inputSchema: {
        type: "object",
        properties: {
          baseline: {
            type: "string",
            description:
              "Snapshot path relative to the selected project directory. Defaults to api-snapshot.json.",
          },
          check: {
            type: "boolean",
            description: "Also run the typed-contract check. Default false to keep the diff lazy.",
          },
          dir: {
            type: "string",
            description: "Project subdirectory to inspect.",
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const raw = args as { baseline?: unknown; check?: unknown; dir?: unknown }
        if (raw.dir !== undefined && typeof raw.dir !== "string") {
          return JSON.stringify({ ok: false, error: "dir must be a string" }, null, 2)
        }
        if (raw.baseline !== undefined && typeof raw.baseline !== "string") {
          return JSON.stringify({ ok: false, error: "baseline must be a string" }, null, 2)
        }
        const dir = raw.dir as string | undefined
        const baseline = raw.baseline as string | undefined
        const target = resolveProjectDir(cwd, dir)
        if (target === null) return dirError(dir)
        if (baseline !== undefined && baseline.trim() === "") {
          return JSON.stringify({ ok: false, error: "baseline must not be empty" }, null, 2)
        }
        try {
          return JSON.stringify(
            await collectContractProof(target, {
              ...(baseline === undefined ? {} : { baselinePath: baseline }),
              ...(raw.check === undefined ? {} : { check: raw.check === true }),
            }),
            null,
            2,
          )
        } catch (error) {
          return JSON.stringify(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            null,
            2,
          )
        }
      },
    },
    {
      name: "nifra_prove",
      description:
        "Build the static verification work graph for this project. Pass changed files to get only impacted routes and the cheapest proof plan. The result includes a serializable evidence bundle and a machine-checkable stop condition. Requires a fresh build and never probes a running application.",
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "Project-relative changed files. Omit for a graph overview.",
          },
          minLevel: {
            type: "integer",
            minimum: 0,
            maximum: 4,
            description: "Required proof level for the stop condition. Defaults to 1.",
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const files = args.files
        const minLevel = args.minLevel
        if (
          (files !== undefined &&
            (!Array.isArray(files) || files.some((file) => typeof file !== "string"))) ||
          (minLevel !== undefined &&
            (typeof minLevel !== "number" ||
              !Number.isInteger(minLevel) ||
              minLevel < 0 ||
              minLevel > 4))
        ) {
          return JSON.stringify(
            {
              ok: false,
              error: "files must be strings and minLevel must be an integer from 0 to 4",
            },
            null,
            2,
          )
        }
        try {
          return JSON.stringify(
            await collectProjectWorkGraph(cwd, {
              ...(files === undefined ? {} : { changedFiles: files }),
              ...(minLevel === undefined ? {} : { minLevel }),
            }),
            null,
            2,
          )
        } catch (error) {
          return JSON.stringify(
            { ok: false, error: error instanceof Error ? error.message : "work graph failed" },
            null,
            2,
          )
        }
      },
    },
    {
      name: "nifra_context",
      description:
        "Get this nifra project's surface. Call it once UNFILTERED for a tight INDEX: the route list (API routes as `METHOD path`, page routes as `pattern → file`) + framework conventions + a pointer - cheap even on a big app, no per-route schema dump. Then pass `path` (a route prefix like /api/orders) and/or `kind` (api|pages) to fetch the FULL contract for that slice (body/query/response TS shapes + the exact typed-client call form).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Only routes whose path/pattern starts with this prefix.",
          },
          kind: {
            type: "string",
            enum: ["api", "pages"],
            description: "Limit to API routes or page routes.",
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const filter = args as { path?: string; kind?: "api" | "pages" }
        return describeProject(await loadAppCached(), filter)
      },
    },
    {
      name: "nifra_explain",
      description:
        "Turn a nifra error into a STRUCTURED diagnostic instead of eyeballing a stack trace: a stable `code`, the top frame in YOUR source, a codeframe around the offending line, and - when nifra recognises the failure - the plain-language `cause` + `fix` + docs anchor. Pass `error` (and `stack` if you have it, e.g. from nifra_run/nifra_test output or a failing build) to explain a specific failure; or pass `port` to fetch the running dev server's most recent SSR failure from `/__nifra/last-error`. Returns the same JSON the dev overlay renders.",
      inputSchema: {
        type: "object",
        properties: {
          error: {
            type: "string",
            description:
              "The error message to explain (copy it from nifra_run/nifra_test output or a failing build).",
          },
          stack: {
            type: "string",
            description:
              "The error's stack trace, if you have it - enables the source codeframe and the top user frame.",
          },
          name: {
            type: "string",
            description:
              "The error's class name (e.g. TypeError, SchemaError), if known - sharpens classification.",
          },
          port: {
            type: "number",
            description:
              "Instead of a pasted error, fetch the running dev server's most recent SSR failure from this port.",
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const { error, stack, name, port } = args as {
          error?: string
          stack?: string
          name?: string
          port?: number
        }
        if (error !== undefined || stack !== undefined) {
          const { buildDiagnostic } = await import("@nifrajs/web/diagnostic")
          const e = new Error(error ?? "")
          if (name !== undefined) e.name = name
          if (stack !== undefined) e.stack = stack
          return JSON.stringify(buildDiagnostic(e, { root: cwd }), null, 2)
        }
        if (port !== undefined) {
          const validPort = validateLocalPort(port)
          if (validPort === undefined) {
            return JSON.stringify(
              { code: "NIFRA_INVALID_PORT", message: "port must be an integer from 1 to 65535." },
              null,
              2,
            )
          }
          const { LAST_ERROR_PATH } = await import("@nifrajs/web/diagnostic")
          try {
            const res = await fetch(`http://127.0.0.1:${validPort}${LAST_ERROR_PATH}`, {
              signal: AbortSignal.timeout(LOCAL_TOOL_FETCH_TIMEOUT_MS),
            })
            if (res.headers.get("x-nifra-diagnostic") !== "true")
              return notNifraResponse("diagnostic")
            if (!res.ok) {
              return JSON.stringify(
                {
                  code: "NIFRA_NONE",
                  message: `dev server at :${validPort} returned ${res.status}`,
                },
                null,
                2,
              )
            }
            return await readBoundedResponse(res)
          } catch (cause) {
            return JSON.stringify(
              {
                code: "NIFRA_NONE",
                message: `could not reach a nifra dev server at :${validPort} - ${cause instanceof Error ? cause.message : String(cause)}`,
              },
              null,
              2,
            )
          }
        }
        return JSON.stringify(
          {
            code: "NIFRA_NONE",
            message:
              "Pass `error` (and `stack` if available) to explain a failure, or `port` to fetch the dev server's last error.",
          },
          null,
          2,
        )
      },
    },
    {
      name: "nifra_inspect",
      description:
        "Observe what your requests ACTUALLY did on the running dev server - the recent request traces the DevTools plugin records: `{ method, path, status, durationMs, isrStatus, bodyBytes }` per request. The read no other tool gives you: after nifra_run or a real browser request, call this to SEE the outcome (which route answered, the status, how long, ISR hit/miss) instead of guessing. Pass `port` (the running dev server); narrow with `path` (a path prefix) or `limit` (most recent N). Requires the app to mount `@nifrajs/web`'s `devtools()` plugin (which auto-enables in development).",
      inputSchema: {
        type: "object",
        properties: {
          port: { type: "number", description: "The running dev server's port." },
          path: { type: "string", description: "Only traces whose path starts with this prefix." },
          limit: { type: "number", description: "Return only the most recent N traces." },
        },
        required: ["port"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const { port, path, limit } = args as { port?: number; path?: string; limit?: number }
        if (port === undefined) {
          return JSON.stringify(
            {
              events: [],
              note: "Pass `port` - the running dev server whose request traces to read.",
            },
            null,
            2,
          )
        }
        try {
          const validPort = validateLocalPort(port)
          if (validPort === undefined) {
            return JSON.stringify(
              {
                events: [],
                code: "NIFRA_INVALID_PORT",
                note: "port must be an integer from 1 to 65535.",
              },
              null,
              2,
            )
          }
          const url = new URL(`http://127.0.0.1:${validPort}/_nifra/devtools/state`)
          if (path !== undefined) url.searchParams.set("path", path)
          if (limit !== undefined) url.searchParams.set("limit", String(limit))
          const res = await fetch(url, {
            signal: AbortSignal.timeout(LOCAL_TOOL_FETCH_TIMEOUT_MS),
          })
          if (res.headers.get("x-nifra-devtools") !== "true") return notNifraResponse("DevTools")
          if (res.status === 404) {
            return JSON.stringify(
              {
                events: [],
                note: "No DevTools endpoint on that server. Mount `devtools()` from @nifrajs/web and run in development.",
              },
              null,
              2,
            )
          }
          if (!res.ok) {
            return JSON.stringify(
              { events: [], note: `DevTools state returned ${res.status}.` },
              null,
              2,
            )
          }
          return await readBoundedResponse(res)
        } catch (cause) {
          const validPort = validateLocalPort(port)
          return JSON.stringify(
            {
              events: [],
              note: `Could not reach a dev server at :${validPort ?? String(port)} - ${cause instanceof Error ? cause.message : String(cause)}`,
            },
            null,
            2,
          )
        }
      },
    },
    {
      name: "nifra_routes",
      description:
        "List this project's API routes as STRUCTURED JSON - each `{ method, path, call, body?, query?, response? }`, where `call` is the exact typed-client call form and the shapes are compact TS-typed contracts. For programmatic use (list_routes / get_route_schema) instead of parsing the nifra_context Markdown. No args = every route; pass `path` (a path or prefix like /api/orders) to narrow to those routes.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Only routes whose path starts with this prefix (omit for all routes).",
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const { routesToJson } = await import("./introspect.ts")
        const { path } = args as { path?: string }
        return JSON.stringify(routesToJson(await loadAppCached(), path), null, 2)
      },
    },
    {
      name: "nifra_openapi",
      description:
        'Return this project\'s backend OpenAPI 3.1 document generated from backend.ts route schemas via @nifrajs/schema. Use `format:"json"` for machine edits (default) or `format:"yaml"` for humans. Pass `path` (a route prefix like /api/orders, mirroring nifra_routes) to narrow a large backend to operations under that prefix instead of the whole document. Frontend-only apps return a valid empty paths object.',
      inputSchema: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["json", "yaml"],
            description: "Output format (default: json).",
          },
          path: {
            type: "string",
            description:
              "Only operations whose path starts with this prefix (omit for the whole document).",
          },
        },
        additionalProperties: false,
      },
      handler: (args) => openApiHandler(args, loadAppCached),
    },
    {
      name: "nifra_run",
      description:
        "Run HTTP requests through this project's backend and return structured results (status, headers, parsed body, and any thrown error). Use it to verify code after editing: by default the backend is re-loaded in a fresh process each call. Pass warm:true to reuse a hot worker while source files are unchanged; it restarts automatically when files change. Each request: { method?, path, body?, headers? }.",
      inputSchema: {
        type: "object",
        properties: {
          requests: {
            type: "array",
            items: {
              type: "object",
              properties: {
                method: { type: "string" },
                path: { type: "string" },
                body: {},
                headers: { type: "object" },
              },
              required: ["path"],
            },
          },
          entry: {
            type: "string",
            description: "Backend entry file (default: backend.ts | app.ts).",
          },
          warm: {
            type: "boolean",
            description:
              "Reuse a hot backend worker while source files are unchanged. Default false for maximum isolation.",
          },
        },
        required: ["requests"],
        additionalProperties: false,
      },
      handler: (args, context) => runHandler(cwd, args, context, warmRun),
    },
    {
      name: "nifra_render",
      description:
        "SSR a page route (routes/) through this project's CURRENT web app and return { status, headers, body: the rendered HTML }. The page half of nifra_run: use it to verify a page renders and its loader ran after an edit. No build needed (a placeholder client entry is used; the SSR HTML renders regardless). Each request: { path, headers? }. By default re-loaded in a fresh process each call; pass warm:true to reuse a hot worker while source files are unchanged (it restarts automatically when files change), mirroring nifra_run.",
      inputSchema: {
        type: "object",
        properties: {
          requests: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                headers: { type: "object" },
              },
              required: ["path"],
            },
          },
          warm: {
            type: "boolean",
            description:
              "Reuse a hot web-app worker while source files are unchanged. Default false for maximum isolation.",
          },
        },
        required: ["requests"],
        additionalProperties: false,
      },
      handler: (args, context) => renderHandler(cwd, args, context, warmRender),
    },
    {
      name: "nifra_ws",
      description:
        'Verify a WebSocket route against this project by starting the backend on an ephemeral localhost port, opening a real Bun WebSocket, sending string frames, and returning structured evidence: { ok, opened, sent, received, close?, error? }. Use after adding or editing app.ws() routes. Pass path including query, e.g. "/chat?token=secret". By default expects one message when no messages are sent, or one response per sent message; set expectMessages:0 to verify connect-only routes.',
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'App-local WebSocket path, optionally with query, e.g. "/chat?token=secret".',
          },
          messages: {
            type: "array",
            items: { type: "string" },
            description: "String frames to send after the socket opens (max 50).",
          },
          expectMessages: {
            type: "number",
            description:
              "How many inbound messages must be observed before success (default: messages.length, or 1 with no sent messages; max 50).",
          },
          timeoutMs: {
            type: "number",
            description: "Bounded verification timeout in milliseconds (default 3000, max 30000).",
          },
          entry: {
            type: "string",
            description: "Backend entry file (default: backend.ts | app.ts).",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      handler: (args, context) => wsHandler(cwd, args, context),
    },
    {
      name: "nifra_test",
      description:
        "Run `bun test` for this project and return bounded structured results: { ok, command, durationMs, exitCode, timedOut, summary, stdout, stderr }. Pass `pattern` to narrow to a test file/path; pass `timeoutMs` (default 30000, max 300000). Use after editing code, alongside nifra_run/nifra_render for behavioral checks.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Optional test file/path pattern passed as an argv item to `bun test`.",
          },
          timeoutMs: {
            type: "number",
            description: "Timeout in milliseconds (default 30000, max 300000).",
          },
          dir: {
            type: "string",
            description:
              'Run the tests in this subdirectory (relative to the project root), e.g. "app". Use it when the MCP server\'s root is a monorepo but you want to test just one app. Default: the project root.',
          },
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const { collectTestResult } = await import("./test-tool.ts")
        const opts = args as { dir?: string }
        const target = resolveProjectDir(cwd, opts.dir)
        if (target === null) return dirError(opts.dir)
        return JSON.stringify(
          await collectTestResult(target, args, { signal: context.signal }),
          null,
          2,
        )
      },
    },
    // nifra_docs + nifra_example are project-independent (corpus-backed); the shared factory keeps their
    // definitions identical to the CLI HTTP server and the site's edge worker.
    ...docsTools(loadDocsCorpus, loadExamplesCorpus, loadTypesCorpus),
    {
      name: "nifra_scaffold",
      description:
        'Map a URL path to the CORRECT routes/ file and get a contract-correct page stub. Agents routinely place file routes wrong - this applies the convention for you: ":id"/"[id]" → [id], "*rest" → [...rest], "/" → index. Pass path (e.g. "/users/:id"). Returns the file to create + the route-module contract (loader/action/meta/default) + a stub (ready-to-write for react/preact/solid; path+contract for vue/svelte/vanilla - use nifra_example for those bodies).',
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'The URL path for the new page route, e.g. "/users/:id" or "/blog/*slug".',
          },
          write: {
            type: "boolean",
            description:
              "When true, create the file if a verified ready-to-write stub exists. Refuses overwrite.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const { path, write } = args as { path?: string; write?: boolean }
        if (typeof path !== "string" || path.length === 0) return "scaffold: `path` is required."
        const { frameworkFromClientModule, renderScaffold, writeScaffoldRoute } = await import(
          "./scaffold.ts"
        )
        const app = await loadAppCached()
        const framework = frameworkFromClientModule(app.framework.clientModule)
        if (write !== true) return renderScaffold(path, framework)
        const result = await writeScaffoldRoute(cwd, path, framework)
        const status = result.written
          ? `Written: \`${result.file}\``
          : `Not written: ${result.reason ?? "no write performed"}`
        return `${status}\n\n${renderScaffold(path, framework)}`
      },
    },
    {
      name: "nifra_check",
      description:
        'Run the project\'s drift gate and return a structured result { ok, typecheck, diagnostics[], pipeline? }: typecheck (the frontend↔backend contract), plus lints for hand-rolled fetch() to your own API, untyped client("…") calls missing <typeof app>, and server-only imports in routes/. `pipeline` answers "which bundler does this app run on" (bun|vite, for dev AND build alike) without starting a server, and its `pipeline` diagnostics catch the hazards of having two: a plugin in the slot the other bundler reads (accepted, then never called), a dev toolchain imported by the file `nifra build` bundles into the production server, and `conditions` that cannot reach Bun\'s dev client bundle. Read it before adding a plugin or a compiler. Pass lintsOnly:true for a near-instant lint pass while iterating; run the full gate (default) to confirm the work is done - fix every diagnostic before finishing.',
      inputSchema: {
        type: "object",
        properties: {
          lintsOnly: {
            type: "boolean",
            description: "Skip tsc; run only the near-instant source lints (inner-loop mode).",
          },
          dir: {
            type: "string",
            description:
              'Run the check in this subdirectory (relative to the project root), e.g. "app" or "packages/api". Use it when the MCP server\'s root is a monorepo but you want to check just one app. Default: the project root.',
          },
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const { collectCheckResult } = await import("./check.ts")
        const opts = args as { lintsOnly?: boolean; dir?: string }
        const target = resolveProjectDir(cwd, opts.dir)
        if (target === null) return dirError(opts.dir)
        const result = await collectCheckResult(target, {
          lintsOnly: opts.lintsOnly ?? false,
          signal: context.signal,
          // Bound the result so a large project can't emit an MCP message big enough to break the stdio
          // transport (`-32000: Connection closed`). If `truncated` comes back, fix the shown diagnostics
          // and re-run. The scan already skips gitignored trees (walkSource), so this is the safety net.
          maxDiagnostics: 100,
        })
        return JSON.stringify(
          result.structuredDiagnostics === undefined
            ? result
            : { ...result, diagnostics: result.structuredDiagnostics },
          null,
          2,
        )
      },
    },
    {
      name: "nifra_fix",
      description:
        "Automatically fix diagnostic lints (such as rewriting hand-rolled fetch() calls to the typed nifra client, adding generic types to client factory calls, and resolving dependency drift in package.json). Runs diagnostics, applies all mechanical edit suggestions, applies doctor dependency fixes, and returns the remaining unresolved diagnostics.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "Apply the registered recipe for one stable diagnostic code when available.",
          },
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const { collectCheckResult } = await import("./check.ts")
        const { applyDiagnosticRecipe } = await import("./fix-recipes.ts")
        const { applyDoctorAutoFix } = await import("./doctor.ts")
        const { resolveInsideProject } = await import("./project-path.ts")
        const { writeFile, readFile } = await import("node:fs/promises")

        let doctorResult: Awaited<ReturnType<typeof applyDoctorAutoFix>> | null = null
        try {
          doctorResult = await applyDoctorAutoFix(cwd)
        } catch {
          // ignore doctor errors
        }

        const checkResult = await collectCheckResult(cwd, {
          lintsOnly: true,
          signal: context.signal,
          maxDiagnostics: 100,
        })

        const requestedCode = (args as { code?: unknown }).code
        const recipeFixed: string[] = []
        if (typeof requestedCode === "string") {
          for (const diagnostic of checkResult.structuredDiagnostics ?? []) {
            if (diagnostic.code !== requestedCode) continue
            recipeFixed.push(...(await applyDiagnosticRecipe(cwd, diagnostic)))
          }
        }

        const fixed: Array<{ file: string; line: number; title: string }> = []

        for (const diag of checkResult.diagnostics) {
          if (diag.file && diag.line && diag.suggestion?.kind === "edit" && diag.suggestion.diff) {
            try {
              const diffLines = diag.suggestion.diff.split("\n")
              const beforeLine = diffLines.find((l) => l.startsWith("-"))?.slice(1)
              const afterLine = diffLines.find((l) => l.startsWith("+"))?.slice(1)
              if (beforeLine !== undefined && afterLine !== undefined) {
                const filePath = await resolveInsideProject(cwd, diag.file)
                if (filePath === undefined) continue
                const content = await readFile(filePath, "utf-8")
                const lines = content.split("\n")
                const idx = diag.line - 1
                if (lines[idx] === beforeLine) {
                  lines[idx] = afterLine
                  await writeFile(filePath, lines.join("\n"), "utf-8")
                  fixed.push({
                    file: diag.file,
                    line: diag.line,
                    title: diag.suggestion.title,
                  })
                }
              }
            } catch {
              // ignore edit errors
            }
          }
        }

        const finalResult = await collectCheckResult(cwd, {
          lintsOnly: false,
          signal: context.signal,
          maxDiagnostics: 100,
        })

        return JSON.stringify(
          {
            ok: finalResult.ok,
            fixed,
            recipeFixed,
            doctorFixed: doctorResult?.fixed ?? [],
            remainingDiagnostics: finalResult.diagnostics,
          },
          null,
          2,
        )
      },
    },
    {
      name: "nifra_assure",
      description:
        "Evaluate nifra.assurance.ts and return the complete route-assurance report: every reflected route's first matching policy rule, enforcement evidence, missing/forbidden evidence, and the fail-closed ok bit. Use after adding or changing routes/security middleware; fix every finding before finishing.",
      inputSchema: {
        type: "object",
        properties: {
          config: {
            type: "string",
            description:
              "Config path relative to the selected project directory. Default: nifra.assurance.ts.",
          },
          bundle: {
            type: "boolean",
            description: "Return the single gate bundle with verdict and explicit skipped gates.",
          },
          strict: {
            type: "boolean",
            description: "Treat warning diagnostics as failures in the bundle.",
          },
          hydration: {
            type: "boolean",
            description: "Run the hydration assurance gate.",
          },
          interact: {
            type: "boolean",
            description: "Run declared hydration probes after the client mounts.",
          },
          dir: {
            type: "string",
            description:
              'Evaluate this project subdirectory (relative to the MCP root), e.g. "apps/api". Default: the project root.',
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const opts = args as {
          config?: string
          dir?: string
          bundle?: boolean
          strict?: boolean
          hydration?: boolean
          interact?: boolean
        }
        const target = resolveProjectDir(cwd, opts.dir)
        if (target === null) return dirError(opts.dir)
        const config = opts.config === undefined ? undefined : resolve(target, opts.config)
        if (config !== undefined && config !== target && !config.startsWith(target + sep)) {
          return JSON.stringify(
            { ok: false, error: "config must stay inside the selected project directory" },
            null,
            2,
          )
        }
        const { collectAssuranceReport, collectAssureBundle } = await import("./assure.ts")
        if (opts.bundle === true || opts.strict === true || opts.hydration === true) {
          return JSON.stringify(
            await collectAssureBundle(target, {
              ...(config === undefined ? {} : { config }),
              ...(opts.strict === undefined ? {} : { strict: opts.strict }),
              ...(opts.hydration === undefined ? {} : { hydration: opts.hydration }),
              ...(opts.interact === undefined ? {} : { interact: opts.interact }),
            }),
            null,
            2,
          )
        }
        return JSON.stringify(await collectAssuranceReport(target, config), null, 2)
      },
    },
    {
      name: "nifra_hydrate",
      description: "Run the hydration assurance gate and return stable NF-H diagnostics.",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Project subdirectory to inspect." },
          interact: { type: "boolean", description: "Run declared hydration probes." },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const opts = args as { dir?: string; interact?: boolean }
        const target = resolveProjectDir(cwd, opts.dir)
        if (target === null) return dirError(opts.dir)
        const { runHydrationAssurance } = await import("./assure-hydration.ts")
        return JSON.stringify(
          await runHydrationAssurance(target, { interact: opts.interact === true }),
          null,
          2,
        )
      },
    },
    {
      name: "nifra_replay",
      description: "Validate and dispatch a token-only replay metadata file.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Replay file relative to the project root." },
        },
        required: ["file"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const file = (args as { file?: unknown }).file
        if (typeof file !== "string" || file.trim() === "")
          return JSON.stringify({ ok: false, error: "file is required" })
        const { runReplay } = await import("./replay.ts")
        try {
          return JSON.stringify(await runReplay(cwd, file), null, 2)
        } catch (error) {
          return JSON.stringify(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            null,
            2,
          )
        }
      },
    },
    {
      name: "nifra_levels",
      description:
        "Compute this project's verification ladder and return { achieved, levels[] }, where each level carries { level, name, ok, reasons[] }. The ladder is cumulative: L0 typed contract (nifra check), L1 route assurance, L2 reviewed capability lockfile, L3 route trust manifest in sync, L4 contract invariants, so a level only holds when every level below it holds, and `achieved` is -1 when even L0 fails. This is the single gate that reports what a change actually proves: run it after finishing work, and treat any `reasons` on a level the project already claimed as a regression to fix.",
      inputSchema: {
        type: "object",
        properties: {
          config: {
            type: "string",
            description:
              "Assurance config path relative to the selected project directory. Default: nifra.assurance.ts.",
          },
          seed: {
            type: "number",
            description: "Deterministic seed for the L4 invariant run. Default 1.",
          },
          dir: {
            type: "string",
            description:
              'Evaluate this project subdirectory (relative to the MCP root), e.g. "apps/api". Default: the project root.',
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const opts = args as { config?: string; seed?: number; dir?: string }
        const target = resolveProjectDir(cwd, opts.dir)
        if (target === null) return dirError(opts.dir)
        if (opts.seed !== undefined && !Number.isSafeInteger(opts.seed)) {
          return JSON.stringify({ ok: false, error: "seed must be a safe integer" }, null, 2)
        }
        const config = opts.config === undefined ? undefined : resolve(target, opts.config)
        if (config !== undefined && config !== target && !config.startsWith(target + sep)) {
          return JSON.stringify(
            { ok: false, error: "config must stay inside the selected project directory" },
            null,
            2,
          )
        }
        const { collectVerificationLevels } = await import("./levels-tool.ts")
        return JSON.stringify(
          await collectVerificationLevels(target, {
            ...(opts.config === undefined ? {} : { config: opts.config }),
            ...(opts.seed === undefined ? {} : { seed: opts.seed }),
          }),
          null,
          2,
        )
      },
    },
    {
      name: "nifra_doctor",
      description:
        "Check this project for packages imported in source but NOT declared in package.json - the Bun-workspace trap where an import resolves at runtime (hoisting/workspace) so tests pass and `bun install` says no changes, yet tsc fails and a fresh/standalone install can't resolve it. Also reports `pipeline`: which bundler (bun|vite) this app's dev AND build phases run on and why, plus config hazards that only exist because there are two - a plugin sitting in the slot the other bundler reads (accepted, then never called), a dev toolchain imported by the file `nifra build` bundles into the production server (builds clean, dies at startup), and `conditions` that cannot reach the client bundle Bun's dev server serves. Returns { ok, ran, findings[], pipeline?, fixed?, skippedFixes? }. Pass autoFix:true to update package.json only when the dependency version can be inferred locally from an ancestor package.json or installed package metadata; otherwise the tool returns the exact bun add command to run.",
      inputSchema: {
        type: "object",
        properties: {
          autoFix: {
            type: "boolean",
            description:
              "When true, write safe package.json fixes using only locally inferred versions. Does not run install or use the network.",
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const opts = args as { autoFix?: boolean }
        const { applyDoctorAutoFix, collectDoctorResult } = await import("./doctor.ts")
        return JSON.stringify(
          opts.autoFix === true ? await applyDoctorAutoFix(cwd) : await collectDoctorResult(cwd),
          null,
          2,
        )
      },
    },
  ]
}

type ToolBackend = {
  readonly routes?: () => readonly unknown[]
  readonly fetch: (req: Request) => Promise<Response>
}

/** Extract tools registered via .tool() routes on the Nifra backend. Exported for the test that proves a
 * `server().tool()` route surfaces in `tools/list` and executes through `tools/call`. */
export function extractBackendTools(backend: unknown): McpTool[] {
  const b = backend as ToolBackend | null
  if (!b || typeof b.routes !== "function") return []
  const routes = reflectRoutes(b)

  return routes
    .filter(
      (
        r,
      ): r is ReflectedRoute & {
        schema: NonNullable<ReflectedRoute["schema"]>
        tool: NonNullable<ReflectedRoute["tool"]>
      } => r.schema !== undefined && r.tool !== undefined,
    )
    .map((r) => {
      const toolInfo = r.tool
      const s = r.schema
      return {
        name: toolInfo.name,
        description: toolInfo.description,
        inputSchema: (s.body?.jsonSchema ?? {
          type: "object",
          properties: {},
        }) as McpTool["inputSchema"],
        ...(toolInfo.annotations !== undefined ? { annotations: toolInfo.annotations } : {}),
        handler: async (args): Promise<string | McpToolResult> => {
          const res = await b.fetch(
            new Request(`http://localhost/_nifra/tool/${toolInfo.name}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(args),
            }),
          )
          if (!res.ok) {
            const text = await res.text()
            throw new Error(`Tool execution failed (${res.status}): ${text}`)
          }
          const body: unknown = await res.json()
          if (typeof body === "string") return body
          if (body && typeof body === "object") {
            if ("content" in body || "structuredContent" in body) {
              return body as McpToolResult
            }
            return {
              content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
              structuredContent: body as Record<string, unknown>,
            }
          }
          return String(body)
        },
      }
    })
}

/** A resource declared on the backend via `server().resource()`, seen through `mcpResources()`. */
type ResourceDescriptor = {
  readonly uri: string
  readonly name: string
  readonly description?: string
  readonly mimeType?: string
  readonly read: () => unknown | Promise<unknown>
}
type ResourceBackend = { readonly mcpResources?: () => readonly ResourceDescriptor[] }

/** Extract MCP resources registered via `.resource()` on the Nifra backend. Exported for the surfacing test. */
export function extractBackendResources(backend: unknown): McpResource[] {
  const b = backend as ResourceBackend | null
  if (!b || typeof b.mcpResources !== "function") return []
  let list: readonly ResourceDescriptor[]
  try {
    list = b.mcpResources()
  } catch {
    return []
  }
  return list.map((r) => ({
    uri: r.uri,
    name: r.name,
    ...(r.description !== undefined ? { description: r.description } : {}),
    ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
    read: async () => {
      const out = await r.read()
      if (typeof out === "string") return { text: out }
      const o = out as { text: string; mimeType?: string }
      return o.mimeType !== undefined ? { text: o.text, mimeType: o.mimeType } : { text: o.text }
    },
  }))
}

/** A prompt declared on the backend via `server().prompt()`, seen through `mcpPrompts()`. */
type PromptDescriptor = {
  readonly name: string
  readonly description: string
  readonly arguments?: readonly { name: string; description?: string; required?: boolean }[]
  readonly handler: (args: Record<string, string>) => unknown | Promise<unknown>
}
type PromptBackend = { readonly mcpPrompts?: () => readonly PromptDescriptor[] }

/** Extract MCP prompts registered via `.prompt()` on the Nifra backend. Exported for the surfacing test. */
export function extractBackendPrompts(backend: unknown): McpPrompt[] {
  const b = backend as PromptBackend | null
  if (!b || typeof b.mcpPrompts !== "function") return []
  let list: readonly PromptDescriptor[]
  try {
    list = b.mcpPrompts()
  } catch {
    return []
  }
  return list.map((p) => ({
    name: p.name,
    description: p.description,
    ...(p.arguments !== undefined ? { arguments: p.arguments } : {}),
    handler: async (args: Record<string, unknown>) =>
      (await p.handler(args as Record<string, string>)) as readonly McpPromptMessage[],
  }))
}

/** Prefix every tool name and resource URI for a named app in a monorepo. */
function namespaceForApp(
  name: string,
  tools: McpTool[],
  features: McpServerFeatures,
): { tools: McpTool[]; features: McpServerFeatures } {
  const prefix = `nifra_${name}_`
  const namespacedTools = tools.map((t) => ({
    ...t,
    name: t.name.startsWith("nifra_") ? t.name.replace(/^nifra_/, prefix) : `${name}_${t.name}`,
  }))
  const namespacedResources = (features.resources ?? []).map((r) => ({
    ...r,
    uri: r.uri.replace(/^nifra:\/\//, `nifra://${name}/`),
  }))
  const namespacedPrompts = (features.prompts ?? []).map((p) => ({
    ...p,
    name: p.name.replace(/^nifra_/, prefix),
  }))
  return {
    tools: namespacedTools,
    features: { resources: namespacedResources, prompts: namespacedPrompts },
  }
}

/**
 * Merge the backend-derived resources/prompts into `base` - and keep a project that cannot be loaded
 * from deciding whether the server starts at all.
 *
 * Resources and prompts are OPTIONAL capabilities extracted from the app's backend, so this load is a
 * best-effort enrichment. It was awaited unguarded, which made it a hard boot requirement: `loadApp`
 * needs a web config (`adapter` + `clientModule`) and a `routes/` directory, and a backend-only
 * project - the shape `create-nifra`'s DEFAULT template produces - has neither. On those projects the
 * throw escaped before the JSON-RPC loop began, so the server wrote nothing and exited. `nifra
 * init-agents` would happily register an `.mcp.json` pointing at a server that could never start, and
 * every tool went with it, including the twelve that never touch the app (docs, examples, types,
 * check, doctor, levels, test).
 *
 * Degrading costs only the backend resources/prompts. Tools that genuinely need the app still fail,
 * but per call, with their own message - which is a diagnosis instead of a silence.
 */
async function backendFeatures(
  loader: () => Promise<LoadedApp>,
  base: McpServerFeatures,
): Promise<McpServerFeatures> {
  const resources = [...(base.resources ?? [])]
  const prompts = [...(base.prompts ?? [])]
  try {
    const app = await loader()
    resources.push(...extractBackendResources(app.backend))
    prompts.push(...extractBackendPrompts(app.backend))
  } catch {
    // Not loadable here (no web config, or the config itself throws). The server still serves.
  }
  return { resources, prompts }
}

/**
 * The MCP tools the app itself declares via `app.tool(...)`, or none when the app cannot be loaded.
 *
 * Same reasoning as {@link backendFeatures}, on the hotter path: this ran on EVERY JSON-RPC message,
 * so an unloadable project failed `initialize` itself with a `-32603` and the session never opened.
 * An app's own tools are an extension of the built-in set, so their absence must not withdraw the
 * built-ins - a backend-only project still gets docs, examples, types, check, doctor, levels and test.
 */
async function appDeclaredTools(loader: () => Promise<LoadedApp>): Promise<McpTool[]> {
  try {
    return extractBackendTools((await loader()).backend)
  } catch {
    return []
  }
}

/** Tool names that never touch the project - they serve the bundled docs/examples/types corpus, so
 * they stay available (and unstamped) whatever the root state is. */
const PROJECT_FREE_TOOLS = new Set(["nifra_docs", "nifra_example", "nifra_types", "nifra_learn"])

/** The id of this server's own `roots/list` request to the client. A fixed, namespaced string: the
 * server only ever has one roots request in flight, and no response to a CLIENT-initiated request can
 * carry it (clients pick their own ids; this one is recognisably ours). */
const ROOTS_REQUEST_ID = "nifra:roots/list"

/** Everything derived from the project root - rebuilt wholesale when the root changes (adoption of a
 * client workspace root), so no per-tool state can keep pointing at the old directory. */
interface ProjectContext {
  readonly monorepo: Awaited<ReturnType<typeof detectMonorepo>>
  readonly features: McpServerFeatures
  readonly loadAppCached: () => Promise<LoadedApp>
}

async function createProjectContext(root: string): Promise<ProjectContext> {
  const monorepo = await detectMonorepo(root)
  if (monorepo) {
    const appEntries = await loadMonorepoApps(root, monorepo)
    const allResources: McpResource[] = []
    const allPrompts: McpPrompt[] = []
    for (const { name, cwd: appCwd } of appEntries) {
      const loader = createCachedAppLoader(appCwd)
      const ns = namespaceForApp(
        name,
        [],
        await backendFeatures(loader, projectFeatures(appCwd, loader)),
      )
      allResources.push(...(ns.features.resources ?? []))
      allPrompts.push(...(ns.features.prompts ?? []))
    }
    return {
      monorepo,
      features: { resources: allResources, prompts: allPrompts },
      loadAppCached: createCachedAppLoader(root),
    }
  }
  const loadAppCached = createCachedAppLoader(root)
  return {
    monorepo,
    features: await backendFeatures(loadAppCached, projectFeatures(root, loadAppCached)),
    loadAppCached,
  }
}

/**
 * Wrap every project-scoped tool with the root guard: a bad root ({@link rootVerdict} `blocked`) makes
 * the tool refuse with the remediation message instead of answering about whatever directory the
 * server happened to start in; a good root stamps the result with `[nifra] project root: …` so the
 * agent (and the human reading its transcript) can see WHICH project answered. Docs tools pass
 * through untouched - they serve the bundled corpus, not the project.
 */
export function guardTools(tools: McpTool[], verdict: McpRootVerdict): McpTool[] {
  return tools.map((tool) => {
    if (PROJECT_FREE_TOOLS.has(tool.name)) return tool
    return {
      ...tool,
      handler: async (
        args: Record<string, unknown>,
        context: McpToolContext,
      ): Promise<McpToolResult> => {
        if (verdict.blocked !== undefined) {
          return { content: [{ type: "text", text: verdict.blocked }], isError: true }
        }
        const result = await tool.handler(args, context)
        const note: McpContentBlock = { type: "text", text: verdict.note }
        if (typeof result === "string") {
          return { content: [{ type: "text", text: result }, note] }
        }
        return { ...result, content: [...(result.content ?? []), note] }
      },
    }
  })
}

/** Whether the client's `initialize` params declare the `roots` capability - the precondition for
 * this server sending it a `roots/list` request. */
export function clientSupportsRoots(params: Record<string, unknown> | undefined): boolean {
  const capabilities = params?.capabilities
  if (typeof capabilities !== "object" || capabilities === null) return false
  const roots = (capabilities as { roots?: unknown }).roots
  return typeof roots === "object" && roots !== null
}

/**
 * Run the stdio MCP server: read newline-delimited JSON-RPC from stdin, write responses to stdout.
 *
 * The project root is resolved defensively rather than assumed (`./mcp-root.ts`): explicit
 * `nifra mcp <dir>` beats a cwd guess, a cwd guess walks up to the nearest nifra marker, the client's
 * MCP `roots` (requested after the handshake, re-requested on `roots/list_changed`) can correct an
 * unambiguous wrong guess, and anything still unresolved fails closed per tool call. The effective
 * root is announced in the `initialize` instructions and stamped on every project tool result.
 */
export async function runMcpServer(
  cwd: string,
  version: string,
  explicitDir?: string,
): Promise<void> {
  const requested = explicitDir !== undefined ? resolve(cwd, explicitDir) : cwd
  if (explicitDir !== undefined && !(await stat(requested).catch(() => null))?.isDirectory()) {
    throw new Error(`nifra mcp: directory not found: ${requested}`)
  }
  let rootState = await resolveRootState(requested, explicitDir !== undefined)
  let ctx = await createProjectContext(rootState.root)
  // The CLI answering may not be the nifra the project builds with (a globally installed server, a
  // stale agent config). Recomputed whenever the root moves, since a different project can install a
  // different version.
  let drift: ToolingDrift | undefined = await detectToolingDrift(rootState.root, version)

  const serverInfo = { name: "nifra", version }
  const state = createMcpProtocolState()
  const send = (message: JsonRpcResponse | JsonRpcNotification): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }
  let rootsSupported = false
  const requestRoots = (): void => {
    if (!rootsSupported) return
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: ROOTS_REQUEST_ID, method: "roots/list" })}\n`,
    )
  }
  const onRootsAnswer = async (message: JsonRpcRequest): Promise<void> => {
    const result = (message as { result?: unknown }).result
    // An error response (or a malformed one) carries no roots: keep the current state - the absence
    // of workspace data is not a mismatch, and never a reason to move the root.
    if (result === undefined) return
    const next = await applyClientRoots(rootState, pathsFromRootsResult(result))
    if (next.root !== rootState.root) {
      ctx = await createProjectContext(next.root)
      drift = await detectToolingDrift(next.root, version)
    }
    rootState = next
  }

  // Root updates are serialized against tool dispatch: a message read AFTER the client's roots answer
  // must see the adopted root, even though dispatches themselves run concurrently.
  let rootsUpdate: Promise<void> = Promise.resolve()

  const dispatch = async (message: JsonRpcRequest): Promise<void> => {
    // The client's answer to OUR `roots/list` request - a response (id, no method), which the pure
    // dispatch would reject as an unknown method. Intercept it before handleRpc ever sees it.
    if (message.method === undefined && message.id === ROOTS_REQUEST_ID) {
      // Swallow failures: a bad answer must not poison the chain and 500 every later dispatch.
      rootsUpdate = onRootsAnswer(message).catch(() => {})
      await rootsUpdate
      return
    }
    await rootsUpdate
    if (message.method === "initialize") {
      rootsSupported = clientSupportsRoots(message.params)
    }

    let activeTools: McpTool[]
    if (ctx.monorepo) {
      const appEntries = await loadMonorepoApps(rootState.root, ctx.monorepo)
      const allTools: McpTool[] = []
      for (const { name, cwd: appCwd } of appEntries) {
        const loader = createCachedAppLoader(appCwd)
        const tools = [...projectTools(appCwd, loader), ...(await appDeclaredTools(loader))]
        const ns = namespaceForApp(name, tools, { resources: [], prompts: [] })
        allTools.push(...ns.tools)
      }
      activeTools = [...docsTools(loadDocsCorpus, loadExamplesCorpus, loadTypesCorpus), ...allTools]
    } else {
      activeTools = [
        ...projectTools(rootState.root, ctx.loadAppCached),
        ...(await appDeclaredTools(ctx.loadAppCached)),
      ]
    }
    const verdict = await rootVerdict(rootState)
    activeTools = guardTools(
      activeTools,
      drift === undefined || verdict.blocked !== undefined
        ? verdict
        : { ...verdict, note: `${verdict.note}\n${driftNote(drift)}` },
    )

    const features: McpServerFeatures = {
      ...ctx.features,
      instructions: rootInstructions(rootState, drift),
    }
    const response = await handleRpc(message, activeTools, serverInfo, features, {
      state,
      sendNotification: send,
    })
    if (response) send(response)
    // Ask for the client's workspace roots once the handshake completes, and again whenever the
    // client says they changed. The answer comes back through the interception above.
    if (
      message.method === "notifications/initialized" ||
      message.method === "notifications/roots/list_changed"
    ) {
      requestRoots()
    }
  }

  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let nl = buffer.indexOf("\n")
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf("\n")
      if (line === "") continue
      let message: JsonRpcRequest
      try {
        message = JSON.parse(line)
      } catch {
        send(rpcError(null, -32700, "parse error"))
        continue
      }
      void dispatch(message).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        send(rpcError(message.id ?? null, -32603, msg))
      })
    }
  }
}
