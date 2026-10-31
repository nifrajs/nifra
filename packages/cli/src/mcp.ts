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
 *   - `nifra_errors`  - the running dev server's errors (SSR, loader, API, build, browser, hydration,
 *     crash), each a structured diagnostic tagged with its request; `since` cursors, stale flags.
 *   - `nifra_logs`    - the dev server's console output, server and browser, tagged by request.
 *   - `nifra_db_schema` / `nifra_db_query` / `nifra_db_role` - the development database declared as
 *     `devDatabase` in nifra.config.ts: its schema, one read-only query (or plan) per call in a fresh
 *     subprocess killed at the deadline, and the SQL for a read-only role. Separate tools, so a client
 *     can allow reading the schema without allowing queries.
 *   - `nifra_explain` - resolve an error (pasted, or the dev server's latest) into a structured
 *     diagnostic: stable code, a codeframe in the user's source, and the recognised cause + fix.
 *   - `nifra_inspect` - read the running dev server's recent request traces (method/path/status/
 *     duration/ISR/errors): what your requests ACTUALLY did, not a guess.
 *
 * Wire it into a client (e.g. Claude Desktop / Cursor) as: command `nifra`, args `["mcp"]` (or
 * `["mcp", "<dir>"]` to pin the project directory explicitly). The server does NOT silently trust its
 * spawn directory: the root is resolved via `./mcp-root.ts` (marker walk-up, the client's MCP `roots`,
 * fail-closed tools when no nifra project is found) and announced in `initialize` + on every project
 * tool result. A project that installs its own `@nifrajs/cli` at a different version gets the session
 * handed to that CLI; when that is impossible the version-sensitive tools refuse rather than answer
 * for the wrong release (see `./mcp-delegate.ts`). The protocol is hand-rolled (newline-delimited JSON-RPC 2.0 over stdio), including
 * standard MCP progress notifications and request cancellation - no SDK dependency, the same
 * minimal-surface choice as the rest of nifra. The pure dispatch lives in `./mcp-protocol.ts` and the
 * stdio framing in `@nifrajs/mcp/stdio`; this module is the dispatch shell (roots, tool wiring, the run
 * subprocess).
 *
 * This process runs no project code and holds none of the project's `.env`: the config, the backend
 * and everything they import run in a fresh subprocess per call (`./mcp-isolate.ts`), and a session
 * whose process Bun started with `.env` values moves to a copy that never loads them (`./cli.ts`).
 */

import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { runStdioTransport, type StdioConnection } from "@nifrajs/mcp/stdio"
import { loadDocsCorpus } from "./docs-search.ts"
import { loadExamplesCorpus } from "./examples.ts"
import type { AppLoader } from "./load.ts"
import { loadMonorepoApps } from "./load.ts"
import { delegateToProjectCli, projectCliCommand, refuseVersionSensitive } from "./mcp-delegate.ts"
import { docsTools } from "./mcp-docs-tools.ts"
import {
  createMcpProtocolState,
  handleRpc,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpPrompt,
  type McpResource,
  type McpServerFeatures,
  type McpTool,
  rpcError,
} from "./mcp-protocol.ts"
import { type McpRelay, startRelay } from "./mcp-relay.ts"
import { loadTypesCorpus } from "./types-search.ts"

export {
  extractBackendPrompts,
  extractBackendResources,
  extractBackendTools,
} from "./mcp-reflect.ts"

import {
  applyClientRoots,
  clientSupportsRoots,
  detectToolingDrift,
  driftNote,
  guardTools,
  pathsFromRootsResult,
  resolveRootState,
  rootInstructions,
  rootVerdict,
  type ToolingDrift,
} from "./mcp-root.ts"

export type { BoundedLine, BoundedOutput } from "./mcp-io.ts"
export {
  CHILD_INPUT_MAX_BYTES,
  CHILD_OUTPUT_MAX_BYTES,
  CHILD_TIMEOUT_MS,
  LOCAL_TOOL_FETCH_TIMEOUT_MS,
  LOCAL_TOOL_MAX_RESPONSE_BYTES,
  notNifraResponse,
  readBoundedLines,
  readBoundedResponse,
  readBoundedStream,
  serializeBoundedJson,
  timeoutMessage,
  validateLocalPort,
} from "./mcp-io.ts"
export { clientSupportsRoots, guardTools } from "./mcp-root.ts"

import { closeWarmWorkers, projectTools } from "./mcp-exec.ts"
import {
  createAppSurface,
  detectMonorepoIsolated,
  type IsolatedSurface,
  isolateResources,
  isolateTools,
} from "./mcp-isolate.ts"

export type { CachedAppLoaderOptions } from "./mcp-exec.ts"
export {
  catalogProjectTools,
  createCachedAppLoader,
  createWarmHandler,
  projectTools,
  renderHandler,
  runHandler,
  spawnChild,
  toMcpTool,
  WarmWorker,
  wsHandler,
} from "./mcp-exec.ts"

import { namespaceForApp, projectPrompts, projectResources } from "./mcp-context.ts"

export type { CommandMcpToolOptions } from "./mcp-context.ts"
export {
  dirError,
  namespaceForApp,
  projectFeatures,
  projectPrompts,
  projectResources,
  resolveProjectDir,
} from "./mcp-context.ts"

/**
 * The loader the server builds its tool and resource lists with. It never loads: every handler that
 * reaches the app runs in a project subprocess (`./mcp-isolate.ts`), so one that tried here fails.
 */
const refuseApp = (): Promise<never> =>
  Promise.reject(
    new Error("[nifra] the MCP server does not load the app; project code runs in a subprocess"),
  )
const noAppInServer: AppLoader = Object.assign(refuseApp, { backend: refuseApp })

const isolatedToolsByDir = new Map<string, McpTool[]>()

/**
 * The project's tools, each forwarded to a project subprocess unless it runs no project code. Built
 * once per directory: `nifra_run`/`nifra_render` hold their warm worker in the tool, so a list rebuilt
 * per message started a fresh worker for every `warm: true` call.
 */
function isolatedProjectTools(cwd: string): McpTool[] {
  let tools = isolatedToolsByDir.get(cwd)
  if (tools === undefined) {
    tools = isolateTools(cwd, projectTools(cwd, noAppInServer))
    isolatedToolsByDir.set(cwd, tools)
  }
  return tools
}

/** The project's resources and prompts, with the ones the app declares. */
function appFeatures(cwd: string, surface: IsolatedSurface): McpServerFeatures {
  return {
    resources: [
      ...isolateResources(cwd, projectResources(cwd, noAppInServer)),
      ...surface.resources,
    ],
    prompts: [...projectPrompts(), ...surface.prompts],
  }
}

const ROOTS_REQUEST_ID = "nifra:roots/list"
/** Messages whose answer reads nothing the app declares: the handshake is never held up by its import. */
const ANSWERED_WITHOUT_THE_APP: ReadonlySet<string> = new Set([
  "initialize",
  "ping",
  "notifications/initialized",
  "notifications/roots/list_changed",
])

interface ProjectApp {
  readonly name: string
  readonly cwd: string
  readonly surface: () => Promise<IsolatedSurface>
}

/** Everything derived from the project root - rebuilt wholesale when the root changes (adoption of a
 * client workspace root), so no per-tool state can keep pointing at the old directory. */
interface ProjectContext {
  /** A monorepo root's apps; `undefined` when the root is one app. */
  readonly apps: readonly ProjectApp[] | undefined
  readonly features: McpServerFeatures
  readonly surface: () => Promise<IsolatedSurface>
}

async function createProjectContext(root: string): Promise<ProjectContext> {
  const monorepo = await detectMonorepoIsolated(root)
  if (monorepo) {
    const apps = (await loadMonorepoApps(root, monorepo)).map(
      ({ name, cwd }): ProjectApp => ({ name, cwd, surface: createAppSurface(cwd) }),
    )
    const allResources: McpResource[] = []
    const allPrompts: McpPrompt[] = []
    // Each app loads in its own subprocess, so they load side by side.
    const loaded = await Promise.all(
      apps.map(async (app) => ({ app, surface: await app.surface() })),
    )
    for (const { app, surface } of loaded) {
      const ns = namespaceForApp(app.name, [], appFeatures(app.cwd, surface))
      allResources.push(...(ns.features.resources ?? []))
      allPrompts.push(...(ns.features.prompts ?? []))
    }
    return {
      apps,
      features: { resources: allResources, prompts: allPrompts },
      surface: createAppSurface(root),
    }
  }
  const surface = createAppSurface(root)
  return { apps: undefined, features: appFeatures(root, await surface()), surface }
}

/**
 * Run the stdio MCP server: read newline-delimited JSON-RPC from stdin, write responses to stdout.
 *
 * Root resolution, trust, and project-tool execution are delegated to their own seams; this function
 * owns only the stdio lifecycle and JSON-RPC dispatch loop.
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
  if (rootState.isProject) {
    // Before anything reads stdin: a hand-off child inherits the descriptor and owns the session.
    const exitCode = await delegateToProjectCli({
      cwd,
      root: rootState.root,
      version,
      args: explicitDir === undefined ? [] : [requested],
    })
    if (exitCode !== undefined) {
      process.exitCode = exitCode
      return
    }
  }
  // Loaded in the background: the app's import can take seconds, and the handshake needs none of it.
  let ctx = createProjectContext(rootState.root)
  ctx.catch(() => {})
  let drift: ToolingDrift | undefined = await detectToolingDrift(rootState.root, version)
  const serverInfo = { name: "nifra", version }
  const state = createMcpProtocolState()
  let rootsSupported = false
  let rootsRequestPending = false
  // The project's own CLI, serving the session once the project installs one that is not this one.
  let relay: McpRelay | undefined
  let takingOver: Promise<McpRelay | undefined> | undefined
  let relayFailed: string | undefined
  let initializeRequest: JsonRpcRequest | undefined
  let initializedSent = false
  const takeOver = async (connection: StdioConnection): Promise<McpRelay | undefined> => {
    // The child asks for roots with the id this process uses, so an answer in flight is not ambiguous.
    if (!rootState.isProject || initializeRequest === undefined || rootsRequestPending)
      return undefined
    const target = await projectCliCommand({
      root: rootState.root,
      version,
      args: explicitDir === undefined ? [] : [requested],
    })
    if (target === undefined) return undefined
    const key = `${target.cli.bin}@${target.cli.version}`
    if (relayFailed === key) return undefined
    const started = await startRelay({
      command: target.command,
      cwd,
      env: target.env,
      initialize: initializeRequest,
      initialized: initializedSent,
      send: connection.send,
      announce: `[nifra] mcp: this server is ${version}; the project now installs @nifrajs/cli ${target.cli.version} - serving the rest of this session from ${target.cli.bin}`,
    })
    if (started === undefined) relayFailed = key
    // A client that listed the old tools lists them again.
    else connection.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
    return started
  }
  const requestRoots = (connection: StdioConnection): void => {
    if (!rootsSupported || rootsRequestPending) return
    rootsRequestPending = true
    connection.send({ jsonrpc: "2.0", id: ROOTS_REQUEST_ID, method: "roots/list" })
  }
  const onRootsAnswer = async (message: JsonRpcResponse): Promise<void> => {
    const result = "result" in message ? message.result : undefined
    // An error response (or a malformed one) carries no roots: keep the current state - the absence
    // of workspace data is not a mismatch, and never a reason to move the root.
    if (result === undefined) return
    const next = await applyClientRoots(rootState, pathsFromRootsResult(result))
    if (next.root !== rootState.root) {
      ctx = createProjectContext(next.root)
      ctx.catch(() => {})
      drift = await detectToolingDrift(next.root, version)
    }
    rootState = next
  }

  // Root updates are serialized against tool dispatch: a message read AFTER the client's roots answer
  // must see the adopted root, even though dispatches themselves run concurrently.
  let rootsUpdate: Promise<void> = Promise.resolve()

  const dispatchRootsAnswer = (message: JsonRpcResponse): boolean => {
    // The roots answer is a response to a request initiated by this server, not a client RPC request.
    // Serialize adoption with normal dispatch so a following request cannot observe a half-updated root.
    if (relay?.alive === true) {
      relay.answer(message)
      return true
    }
    if (message.id !== ROOTS_REQUEST_ID) return false
    if (!rootsRequestPending) return true
    rootsRequestPending = false
    rootsUpdate = onRootsAnswer(message).catch(() => {})
    return true
  }

  const dispatch = async (
    message: JsonRpcRequest,
    connection: StdioConnection,
  ): Promise<JsonRpcResponse | null> => {
    await rootsUpdate
    if (message.method === "initialize") {
      rootsSupported = clientSupportsRoots(message.params)
      initializeRequest = message
    }
    if (message.method === "notifications/initialized") initializedSent = true
    // An install during the session leaves this process listing and running the tools it started with.
    if (
      relay === undefined &&
      (message.method === "tools/list" || message.method === "tools/call")
    ) {
      takingOver ??= takeOver(connection)
      relay = await takingOver
      takingOver = undefined
    }
    if (relay?.alive === true) return relay.request(message)
    // An install during the session changes the nifra the project builds with, and this process keeps
    // the code it started with: re-read the installed version per call so no answer is for a stale one.
    if (message.method === "tools/call") drift = await detectToolingDrift(rootState.root, version)

    const method = message.method ?? ""
    if (ANSWERED_WITHOUT_THE_APP.has(method)) {
      const response = await handleRpc(
        message,
        [],
        serverInfo,
        {
          resources: projectResources(rootState.root, noAppInServer),
          prompts: projectPrompts(),
          instructions: rootInstructions(rootState, drift),
        },
        { state, sendNotification: connection.send, exposeToolErrors: true },
      )
      // Ask for the client's workspace roots once the handshake completes, and again whenever the
      // client says they changed. The answer comes back through `dispatchRootsAnswer`.
      if (method.startsWith("notifications/")) requestRoots(connection)
      return response
    }
    const project = await ctx
    let activeTools: McpTool[]
    if (project.apps) {
      const loaded = await Promise.all(
        project.apps.map(async (app) => ({ app, surface: await app.surface() })),
      )
      const allTools: McpTool[] = []
      for (const { app, surface } of loaded) {
        const tools = [
          ...refuseVersionSensitive(isolatedProjectTools(app.cwd), drift),
          ...surface.tools,
        ]
        const ns = namespaceForApp(app.name, tools, { resources: [], prompts: [] })
        allTools.push(...ns.tools)
      }
      activeTools = [
        ...refuseVersionSensitive(
          docsTools(loadDocsCorpus, loadExamplesCorpus, loadTypesCorpus),
          drift,
        ),
        ...allTools,
      ]
    } else {
      activeTools = [
        ...refuseVersionSensitive(isolatedProjectTools(rootState.root), drift),
        ...(await project.surface()).tools,
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
      ...project.features,
      instructions: rootInstructions(rootState, drift),
    }
    return handleRpc(message, activeTools, serverInfo, features, {
      state,
      sendNotification: connection.send,
      // The stdio caller is the developer's own agent: a failure it cannot read it cannot fix.
      exposeToolErrors: true,
    })
  }

  try {
    await runStdioTransport({
      onRequest: async (message, connection) => {
        try {
          return await dispatch(message, connection)
        } catch (err) {
          // Same audience as `exposeToolErrors`: a project that fails to load says why.
          if (message.id === undefined) return null
          return rpcError(message.id, -32603, err instanceof Error ? err.message : String(err))
        }
      },
      onResponse: dispatchRootsAnswer,
    })
  } finally {
    await relay?.close()
    closeWarmWorkers()
  }
}
