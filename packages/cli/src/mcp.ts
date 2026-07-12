/**
 * `nifra mcp` — a Model Context Protocol server (stdio) that lets a coding agent (Claude, Cursor, …)
 * act on a nifra project, not just read about it:
 *
 *   - `nifra_context` — this project's API routes + page routes + conventions (see {@link describeProject}).
 *   - `nifra_run`     — run HTTP requests through the project's backend and return structured results
 *     (status, body, errors). The write → run → see-the-failure → fix loop, powered by `@nifrajs/runner`.
 *     Each call runs the backend in a FRESH subprocess, so it reflects the agent's latest edits.
 *   - `nifra_render`  — SSR a page route through the project's web app; returns the rendered HTML (the
 *     page half of `nifra_run`). Fresh subprocess per call; no build needed.
 *   - `nifra_ws`      — verify a WebSocket route with a real Bun WebSocket round-trip.
 *   - `nifra_docs`    — keyword-search the framework docs; returns only the matching sections.
 *   - `nifra_example` — a verified, copy-pasteable snippet for a task (typechecked against the live API,
 *     so it can't hallucinate a drifted nifra API).
 *   - `nifra_scaffold`— map a URL path to the correct `routes/` file + a contract-correct page stub.
 *   - `nifra_check`   — the drift gate (typecheck + lints, each with a structured fix), for an agent to fix against.
 *   - `nifra_assure`  — route classification + enforcement-evidence gate.
 *   - `nifra_doctor`  — package.json dependency drift detector, with safe local-version auto-fix.
 *
 * Wire it into a client (e.g. Claude Desktop / Cursor) as: command `nifra`, args `["mcp"]`, run in the
 * project root. The protocol is hand-rolled (newline-delimited JSON-RPC 2.0 over stdio), including
 * standard MCP progress notifications and request cancellation — no SDK dependency, the same
 * minimal-surface choice as the rest of nifra. The pure dispatch lives in `./mcp-protocol.ts`; this
 * module is the I/O shell (stdin loop, tool wiring, the run subprocess).
 */

import { readFile, stat } from "node:fs/promises"
import { basename, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { type ReflectedRoute, reflectRoutes } from "@nifrajs/core/reflection"
import { Glob } from "bun"
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
  type McpPrompt,
  type McpPromptMessage,
  type McpResource,
  type McpServerFeatures,
  type McpTool,
  type McpToolContext,
  type McpToolResult,
  rpcError,
} from "./mcp-protocol.ts"
import { loadTypesCorpus } from "./types-search.ts"

/** Path to a sibling child entry (`mcp-run` / `mcp-render` / `mcp-ws`), resolved next to this module (`.ts` in
 * dev, `.js` once built). Each runs in a FRESH subprocess per call so the project's current code loads. */
function childPath(name: "mcp-run" | "mcp-render" | "mcp-ws"): string {
  return fileURLToPath(new URL(import.meta.url)).replace(/mcp\.(ts|js)$/, `${name}.$1`)
}

/** Spawn `bun <child> <cwd>`, pipe `input` to its stdin, return its stdout (or a stderr-backed error). */
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
    return out.trim() || `${label} failed:\n${err.trim() || "(no output)"}`
  } finally {
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
 * powers both `nifra_run warm` and `nifra_render warm` — `child` selects which engine, `label` shapes the
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
        // cold rebuild. Leave it hot — `createWarmHandler` already replaces it on file change.
        this.pending.delete(id)
        const reason = typeof signal?.reason === "string" ? `: ${signal.reason}` : ""
        resolve(`${this.label} cancelled${reason}.`)
      }
      const cleanup = (): void => signal?.removeEventListener("abort", abort)
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
 * `nifra_render` (`child: "mcp-render"`, `label: "render"`) — the only differences are the engine and the
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
 * Resolve an optional `dir` tool argument — a subdirectory of the project root the caller wants to scope a
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
    { ok: false, error: `dir must be a subdirectory of the project root — "${dir}" escapes it.` },
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
      name: "nifra_context",
      description:
        "Get this nifra project's surface. Call it once UNFILTERED for a tight INDEX: the route list (API routes as `METHOD path`, page routes as `pattern → file`) + framework conventions + a pointer — cheap even on a big app, no per-route schema dump. Then pass `path` (a route prefix like /api/orders) and/or `kind` (api|pages) to fetch the FULL contract for that slice (body/query/response TS shapes + the exact typed-client call form).",
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
      name: "nifra_routes",
      description:
        "List this project's API routes as STRUCTURED JSON — each `{ method, path, call, body?, query?, response? }`, where `call` is the exact typed-client call form and the shapes are compact TS-typed contracts. For programmatic use (list_routes / get_route_schema) instead of parsing the nifra_context Markdown. No args = every route; pass `path` (a path or prefix like /api/orders) to narrow to those routes.",
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
        'Map a URL path to the CORRECT routes/ file and get a contract-correct page stub. Agents routinely place file routes wrong — this applies the convention for you: ":id"/"[id]" → [id], "*rest" → [...rest], "/" → index. Pass path (e.g. "/users/:id"). Returns the file to create + the route-module contract (loader/action/meta/default) + a stub (ready-to-write for react/preact/solid; path+contract for vue/svelte/vanilla — use nifra_example for those bodies).',
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
        'Run the project\'s drift gate and return a structured result { ok, typecheck, diagnostics[] }: typecheck (the frontend↔backend contract), plus lints for hand-rolled fetch() to your own API, untyped client("…") calls missing <typeof app>, and server-only imports in routes/. Pass lintsOnly:true for a near-instant lint pass while iterating; run the full gate (default) to confirm the work is done — fix every diagnostic before finishing.',
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
        return JSON.stringify(
          await collectCheckResult(target, {
            lintsOnly: opts.lintsOnly ?? false,
            signal: context.signal,
            // Bound the result so a large project can't emit an MCP message big enough to break the stdio
            // transport (`-32000: Connection closed`). If `truncated` comes back, fix the shown diagnostics
            // and re-run. The scan already skips gitignored trees (walkSource), so this is the safety net.
            maxDiagnostics: 100,
          }),
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
        properties: {},
        additionalProperties: false,
      },
      handler: async (_args, context) => {
        const { collectCheckResult } = await import("./check.ts")
        const { applyDoctorAutoFix } = await import("./doctor.ts")
        const { writeFile, readFile } = await import("node:fs/promises")
        const { resolve } = await import("node:path")

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

        const fixed: Array<{ file: string; line: number; title: string }> = []

        for (const diag of checkResult.diagnostics) {
          if (diag.file && diag.line && diag.suggestion?.kind === "edit" && diag.suggestion.diff) {
            try {
              const diffLines = diag.suggestion.diff.split("\n")
              const beforeLine = diffLines.find((l) => l.startsWith("-"))?.slice(1)
              const afterLine = diffLines.find((l) => l.startsWith("+"))?.slice(1)
              if (beforeLine !== undefined && afterLine !== undefined) {
                const filePath = resolve(cwd, diag.file)
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
          dir: {
            type: "string",
            description:
              'Evaluate this project subdirectory (relative to the MCP root), e.g. "apps/api". Default: the project root.',
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const opts = args as { config?: string; dir?: string }
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
        const { collectAssuranceReport } = await import("./assure.ts")
        return JSON.stringify(await collectAssuranceReport(target, config), null, 2)
      },
    },
    {
      name: "nifra_doctor",
      description:
        "Check this project for packages imported in source but NOT declared in package.json — the Bun-workspace trap where an import resolves at runtime (hoisting/workspace) so tests pass and `bun install` says no changes, yet tsc fails and a fresh/standalone install can't resolve it. Returns { ok, ran, findings[], fixed?, skippedFixes? }. Pass autoFix:true to update package.json only when the dependency version can be inferred locally from an ancestor package.json or installed package metadata; otherwise the tool returns the exact bun add command to run.",
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

/** Run the stdio MCP server: read newline-delimited JSON-RPC from stdin, write responses to stdout. */
export async function runMcpServer(cwd: string, version: string): Promise<void> {
  let features: McpServerFeatures

  const monorepo = await detectMonorepo(cwd)
  if (monorepo) {
    const appEntries = await loadMonorepoApps(cwd, monorepo)
    const allResources: McpResource[] = []
    const allPrompts: McpPrompt[] = []
    for (const { name, cwd: appCwd } of appEntries) {
      const loader = createCachedAppLoader(appCwd)
      const app = await loader()
      const base = projectFeatures(appCwd, loader)
      const ns = namespaceForApp(name, [], {
        resources: [...(base.resources ?? []), ...extractBackendResources(app.backend)],
        prompts: [...(base.prompts ?? []), ...extractBackendPrompts(app.backend)],
      })
      allResources.push(...(ns.features.resources ?? []))
      allPrompts.push(...(ns.features.prompts ?? []))
    }
    features = { resources: allResources, prompts: allPrompts }
  } else {
    const loadAppCached = createCachedAppLoader(cwd)
    const base = projectFeatures(cwd, loadAppCached)
    const app = await loadAppCached()
    features = {
      resources: [...(base.resources ?? []), ...extractBackendResources(app.backend)],
      prompts: [...(base.prompts ?? []), ...extractBackendPrompts(app.backend)],
    }
  }
  const loadAppCached = createCachedAppLoader(cwd)
  const serverInfo = { name: "nifra", version }
  const state = createMcpProtocolState()
  const send = (message: JsonRpcResponse | JsonRpcNotification): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }
  const dispatch = async (message: JsonRpcRequest): Promise<void> => {
    let activeTools: McpTool[]
    if (monorepo) {
      const appEntries = await loadMonorepoApps(cwd, monorepo)
      const allTools: McpTool[] = []
      for (const { name, cwd: appCwd } of appEntries) {
        const loader = createCachedAppLoader(appCwd)
        const app = await loader()
        const baseTools = projectTools(appCwd, loader)
        const backendTools = extractBackendTools(app.backend)
        const ns = namespaceForApp(name, [...baseTools, ...backendTools], {
          resources: [],
          prompts: [],
        })
        allTools.push(...ns.tools)
      }
      activeTools = [...docsTools(loadDocsCorpus, loadExamplesCorpus, loadTypesCorpus), ...allTools]
    } else {
      const app = await loadAppCached()
      const baseTools = projectTools(cwd, loadAppCached)
      const backendTools = extractBackendTools(app.backend)
      activeTools = [...baseTools, ...backendTools]
    }

    const response = await handleRpc(message, activeTools, serverInfo, features, {
      state,
      sendNotification: send,
    })
    if (response) send(response)
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
