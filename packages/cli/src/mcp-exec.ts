/**
 * Shared project-tool execution for stdio, run, and render.
 *
 * This module owns child-process limits, warm-worker lifecycle, source fingerprinting, and cached app
 * loading. It has no JSON-RPC transport or root-trust policy, so those seams remain independently
 * replaceable.
 */

import { stat } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { Glob } from "bun"
import {
  type CommandCatalogEntry,
  type CommandCtx,
  type CommandSpec,
  commandCatalog,
  commandMcpName,
  findCommandSpec,
} from "./command-catalog.ts"
import { collectContractProof } from "./contract-proof.ts"
import { loadDocsCorpus } from "./docs-search.ts"
import { loadExamplesCorpus } from "./examples.ts"
import type { LoadAppOptions, LoadedApp } from "./load.ts"
import {
  type CommandMcpToolOptions,
  dirError,
  openApiHandler,
  resolveProjectDir,
} from "./mcp-context.ts"
import { docsTools } from "./mcp-docs-tools.ts"
import {
  CHILD_OUTPUT_MAX_BYTES,
  CHILD_TIMEOUT_MS,
  LOCAL_TOOL_FETCH_TIMEOUT_MS,
  notNifraResponse,
  readBoundedResponse,
  readBoundedStream,
  timeoutMessage,
  validateLocalPort,
} from "./mcp-io.ts"
import type { McpTool, McpToolContext } from "./mcp-protocol.ts"
import { loadTypesCorpus } from "./types-search.ts"

/** Path to a sibling child entry (`mcp-run` / `mcp-render` / `mcp-ws`), resolved next to this module (`.ts` in
 * dev, `.js` once built). Each runs in a FRESH subprocess per call so the project's current code loads. */

export function toMcpTool(
  source: CommandSpec<unknown, unknown> | CommandCatalogEntry,
  options: CommandMcpToolOptions,
): McpTool {
  const spec = "run" in source ? source : findCommandSpec(source.name)
  if (spec === undefined) throw new Error(`missing command spec for ${source.name}`)
  const entry = "run" in source ? undefined : source
  const { cwd } = options
  const loadAppCached = options.loadAppCached ?? createCachedAppLoader(cwd)
  return {
    name: commandMcpName(entry?.name ?? spec.name),
    description: entry?.summary ?? spec.summary,
    inputSchema: entry?.inputSchema ?? spec.input.jsonSchema,
    handler: async (args: Record<string, unknown>, context: McpToolContext) => {
      const raw = { ...args }
      const dir = raw.dir
      if (dir !== undefined && typeof dir !== "string") return dirError(undefined)
      const target = resolveProjectDir(cwd, dir as string | undefined)
      if (target === null) return dirError(dir as string | undefined)
      if (typeof raw.config === "string") {
        const config = resolve(target, raw.config)
        if (config !== target && !config.startsWith(`${target}${sep}`))
          return JSON.stringify(
            { ok: false, error: "config must stay inside the selected project directory" },
            null,
            2,
          )
      }
      delete raw.dir
      let input: unknown
      try {
        input = spec.input.parse(raw)
      } catch (error) {
        return JSON.stringify(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          null,
          2,
        )
      }
      const commandContext: CommandCtx = {
        cwd: target,
        signal: context.signal,
        progress: () => context.reportProgress?.(0.5, 1),
        ...(target === cwd ? { loadApp: loadAppCached } : {}),
      }
      const output = await spec.run(input, commandContext)
      const value = spec.json?.(output, input) ?? output
      return typeof value === "string" ? value : JSON.stringify(value, null, 2)
    },
  }
}

export function catalogProjectTools(
  cwd: string,
  loadAppCached: () => Promise<LoadedApp> = createCachedAppLoader(cwd),
): McpTool[] {
  return commandCatalog
    .filter((entry) => entry.transports.includes("mcp"))
    .map((entry) => {
      const spec = findCommandSpec(entry.name)
      if (spec === undefined) throw new Error(`missing command spec for ${entry.name}`)
      return toMcpTool(spec, { cwd, loadAppCached })
    })
}

export function projectTools(
  cwd: string,
  loadAppCached: (outDirName?: string) => Promise<LoadedApp> = createCachedAppLoader(cwd),
): McpTool[] {
  const warmRun = createWarmHandler("mcp-run", cwd, "run")
  const warmRender = createWarmHandler("mcp-render", cwd, "render")
  const catalogTools = catalogProjectTools(cwd, () => loadAppCached())
  const legacyTools: McpTool[] = [
    {
      name: "nifra_verify",
      description:
        "Run the shared repository verification plan. Set release=true for the full release plan; the response preserves the declarative gate order and each gate's remediation.",
      inputSchema: {
        type: "object",
        properties: {
          release: {
            type: "boolean",
            description: "Run the full release plan instead of the default plan.",
          },
          dir: {
            type: "string",
            description: "Project subdirectory to resolve the repository from.",
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const raw = args as { release?: unknown; dir?: unknown }
        if (raw.release !== undefined && typeof raw.release !== "boolean") {
          return JSON.stringify({ ok: false, error: "release must be a boolean" }, null, 2)
        }
        if (raw.dir !== undefined && typeof raw.dir !== "string") {
          return JSON.stringify({ ok: false, error: "dir must be a string" }, null, 2)
        }
        const target = resolveProjectDir(cwd, raw.dir as string | undefined)
        if (target === null) return dirError(raw.dir as string | undefined)
        const { collectReleaseVerification } = await import("./release-verification.ts")
        return JSON.stringify(
          await collectReleaseVerification(target, {
            mode: raw.release === true ? "release" : "default",
          }),
          null,
          2,
        )
      },
    },
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
  ]
  return [...catalogTools, ...legacyTools]
}

function childPath(name: "mcp-run" | "mcp-render" | "mcp-ws"): string {
  return fileURLToPath(new URL(import.meta.url)).replace(/mcp-exec\.(ts|js)$/, `${name}.$1`)
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
export async function spawnChild(
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
  let killed = false
  const kill = (): void => {
    if (killed) return
    killed = true
    proc.kill()
  }
  const abort = (): void => kill()
  signal?.addEventListener("abort", abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, CHILD_TIMEOUT_MS)
  let outputExceeded = false
  try {
    proc.stdin.write(JSON.stringify(input))
    await proc.stdin.end()
    const [out, err] = await Promise.all([
      readBoundedStream(proc.stdout, CHILD_OUTPUT_MAX_BYTES, () => {
        outputExceeded = true
        kill()
      }),
      readBoundedStream(proc.stderr, CHILD_OUTPUT_MAX_BYTES, () => {
        outputExceeded = true
        kill()
      }),
    ])
    await proc.exited
    if (signal?.aborted) {
      const reason = typeof signal.reason === "string" ? `: ${signal.reason}` : ""
      return `${label} cancelled${reason}.`
    }
    if (outputExceeded) {
      return `${label} output exceeded ${CHILD_OUTPUT_MAX_BYTES} bytes and was terminated.`
    }
    // A killed child may still have flushed a complete result before the timer fired; prefer real
    // output over the timeout message so a slow-but-successful render is not reported as a failure.
    const text = out.text.trim()
    if (timedOut && text === "") return timeoutMessage(label, CHILD_TIMEOUT_MS)
    return text || `${label} failed:\n${err.text.trim() || "(no output)"}`
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
      if (value !== undefined && value.byteLength > CHILD_OUTPUT_MAX_BYTES) {
        this.stderrBuffer = boundedAppend(
          this.stderrBuffer,
          `warm ${this.label} worker stdout exceeded ${CHILD_OUTPUT_MAX_BYTES} bytes\n`,
        )
        this.stop()
        return
      }
      this.stdoutBuffer += decoder.decode(value, { stream: true })
      if (this.stdoutBuffer.length > CHILD_OUTPUT_MAX_BYTES) {
        this.stderrBuffer = boundedAppend(
          this.stderrBuffer,
          `warm ${this.label} worker stdout exceeded ${CHILD_OUTPUT_MAX_BYTES} bytes\n`,
        )
        this.stop()
        return
      }
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
export function createWarmHandler(
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
export async function runHandler(
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
export async function renderHandler(
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
export async function wsHandler(
  cwd: string,
  args: Record<string, unknown>,
  context: McpToolContext,
): Promise<string> {
  return spawnChild("mcp-ws", cwd, args, "websocket", context.signal)
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
