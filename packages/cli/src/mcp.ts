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

import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { loadDocsCorpus } from "./docs-search.ts"
import { loadExamplesCorpus } from "./examples.ts"
import type { LoadedApp } from "./load.ts"
import { detectMonorepo, loadMonorepoApps } from "./load.ts"
import { docsTools } from "./mcp-docs-tools.ts"
import {
  createMcpProtocolState,
  handleRpc,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpPrompt,
  type McpResource,
  type McpServerFeatures,
  type McpTool,
  rpcError,
} from "./mcp-protocol.ts"
import {
  extractBackendPrompts,
  extractBackendResources,
  extractBackendTools,
} from "./mcp-reflect.ts"
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

export type { BoundedOutput } from "./mcp-io.ts"
export {
  CHILD_OUTPUT_MAX_BYTES,
  CHILD_TIMEOUT_MS,
  LOCAL_TOOL_FETCH_TIMEOUT_MS,
  LOCAL_TOOL_MAX_RESPONSE_BYTES,
  notNifraResponse,
  readBoundedResponse,
  readBoundedStream,
  timeoutMessage,
  validateLocalPort,
} from "./mcp-io.ts"
export { clientSupportsRoots, guardTools } from "./mcp-root.ts"

import { createCachedAppLoader, projectTools } from "./mcp-exec.ts"

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

import { namespaceForApp, projectFeatures } from "./mcp-context.ts"

export type { CommandMcpToolOptions } from "./mcp-context.ts"
export {
  dirError,
  namespaceForApp,
  projectFeatures,
  projectPrompts,
  projectResources,
  resolveProjectDir,
} from "./mcp-context.ts"

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
  let ctx = await createProjectContext(rootState.root)
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
