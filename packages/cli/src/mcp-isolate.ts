/**
 * Where `nifra mcp` keeps project code: in a fresh subprocess per call (`mcp-project-child.ts`), never
 * in the server. The server lists the tools, resources and prompts and forwards each call; the child,
 * started in the project's directory, loads `.env` there, imports the config and the backend, answers
 * and exits. So the server holds neither the project's environment nor its modules, and every call
 * sees the project's current code.
 */

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { CONFIG_FILE } from "./app-files.ts"
import type { NifraMonorepoConfig } from "./load.ts"
import { appFingerprint } from "./mcp-exec.ts"
import { CHILD_TIMEOUT_MS, readBoundedLines, readBoundedStream } from "./mcp-io.ts"
import type {
  AppSurface,
  ProjectChildAnswer,
  ProjectChildMessage,
  ProjectChildRequest,
} from "./mcp-project-child.ts"
import type {
  McpPrompt,
  McpPromptMessage,
  McpResource,
  McpTool,
  McpToolContext,
  McpToolResult,
} from "./mcp-protocol.ts"

/**
 * Project tools that stay in the server, because none runs project code in this process: each starts
 * its own subprocess (run, render, ws, hydrate, test, the database tools), or reads only the
 * framework's docs or the dev server's feed.
 */
const IN_PROCESS_TOOLS: ReadonlySet<string> = new Set([
  "nifra_run",
  "nifra_render",
  "nifra_ws",
  "nifra_hydrate",
  "nifra_test",
  "nifra_db_schema",
  "nifra_db_query",
  "nifra_db_role",
  "nifra_errors",
  "nifra_logs",
  "nifra_inspect",
  "nifra_explain",
  "nifra_docs",
  "nifra_example",
  "nifra_types",
  "nifra_learn",
  "nifra_frontend",
])

/** A tool result is bounded again by the stdio message limit when the server sends it. */
const ANSWER_MAX_BYTES = 8 * 1024 * 1024

function childPath(): string {
  return fileURLToPath(new URL(import.meta.url)).replace(
    /mcp-isolate\.(ts|js)$/,
    "mcp-project-child.$1",
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isAnswer = (value: unknown): value is ProjectChildAnswer =>
  isRecord(value) &&
  (value.ok === true || (value.ok === false && typeof value.message === "string"))

function parseMessage(text: string): ProjectChildMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (value.type === "answer" && isAnswer(value.answer)) {
    return { type: "answer", answer: value.answer }
  }
  if (value.type === "progress" && typeof value.progress === "number") {
    return typeof value.total === "number"
      ? { type: "progress", progress: value.progress, total: value.total }
      : { type: "progress", progress: value.progress }
  }
  return undefined
}

const failed = (message: string): ProjectChildAnswer => ({
  ok: false,
  message: `[nifra] ${message}`,
})

export interface ProjectChildOptions {
  /** Progress is forwarded to it, and its cancellation kills the subprocess. */
  readonly context?: McpToolContext
  /** Kill the subprocess after this long. Tool calls have none: a client cancels them instead. */
  readonly timeoutMs?: number
}

/** Answer `request` in a fresh subprocess in `cwd`; a crash, a timeout or no answer is `ok: false`. */
export async function askProjectChild(
  cwd: string,
  request: ProjectChildRequest,
  options: ProjectChildOptions = {},
): Promise<ProjectChildAnswer> {
  const { context, timeoutMs } = options
  if (context?.signal.aborted) return failed("the call was cancelled before it started")
  const token = randomUUID()
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">
  try {
    proc = Bun.spawn([process.execPath, childPath(), cwd], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    return failed(
      `cannot start a process in ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let stopped: "timeout" | "cancel" | undefined
  const stop = (reason: "timeout" | "cancel"): void => {
    if (stopped !== undefined) return
    stopped = reason
    proc.kill("SIGKILL")
  }
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop("timeout"), timeoutMs)
  const onAbort = (): void => stop("cancel")
  context?.signal.addEventListener("abort", onAbort, { once: true })
  try {
    proc.stdin.write(JSON.stringify({ ...request, token }))
    await proc.stdin.end()
    const stderr = readBoundedStream(proc.stderr, 16 * 1024)
    let answer: ProjectChildAnswer | undefined
    let tooLarge = false
    for await (const item of readBoundedLines(proc.stdout, ANSWER_MAX_BYTES)) {
      if (item.kind === "too-large") {
        tooLarge = true
        continue
      }
      if (!item.text.startsWith(`${token} `)) continue
      const message = parseMessage(item.text.slice(token.length + 1))
      if (message?.type === "progress") context?.reportProgress(message.progress, message.total)
      else if (message?.type === "answer") answer = message.answer
    }
    const [errors] = await Promise.all([stderr, proc.exited])
    if (answer !== undefined) return answer
    if (stopped === "timeout") {
      return failed(`the project process did not answer within ${timeoutMs}ms and was killed`)
    }
    if (stopped === "cancel") return failed("the call was cancelled")
    if (tooLarge) return failed(`the answer exceeded ${ANSWER_MAX_BYTES} bytes`)
    const tail = errors.text.trim().slice(-600)
    const how = proc.signalCode === null ? `with code ${proc.exitCode}` : `on ${proc.signalCode}`
    return failed(
      `the project process exited ${how} before answering${tail === "" ? "" : `: ${tail}`}`,
    )
  } finally {
    clearTimeout(timer)
    context?.signal.removeEventListener("abort", onAbort)
  }
}

async function callTool(
  cwd: string,
  name: string,
  args: Record<string, unknown>,
  context: McpToolContext,
): Promise<string | McpToolResult> {
  const answer = await askProjectChild(cwd, { op: "tool", name, args }, { context })
  if (!answer.ok) throw new Error(answer.message)
  if ("result" in answer) return answer.result
  throw new Error(`[nifra] the project process answered ${name} without a result`)
}

async function readResource(
  cwd: string,
  uri: string,
): Promise<{ readonly text: string; readonly mimeType?: string }> {
  const answer = await askProjectChild(
    cwd,
    { op: "resource", uri },
    { timeoutMs: CHILD_TIMEOUT_MS },
  )
  if (!answer.ok) throw new Error(answer.message)
  if ("resource" in answer) return answer.resource
  throw new Error(`[nifra] the project process answered ${uri} without its text`)
}

async function getPrompt(
  cwd: string,
  name: string,
  args: Record<string, unknown>,
): Promise<readonly McpPromptMessage[]> {
  const answer = await askProjectChild(
    cwd,
    { op: "prompt", name, args },
    { timeoutMs: CHILD_TIMEOUT_MS },
  )
  if (!answer.ok) throw new Error(answer.message)
  if ("messages" in answer) return answer.messages
  throw new Error(`[nifra] the project process answered ${name} without messages`)
}

/** Each tool runs in a fresh project subprocess, unless it is one that runs no project code here. */
export function isolateTools(cwd: string, tools: readonly McpTool[]): McpTool[] {
  return tools.map((tool) =>
    IN_PROCESS_TOOLS.has(tool.name)
      ? tool
      : { ...tool, handler: (args, context) => callTool(cwd, tool.name, args, context) },
  )
}

/** Each resource is read in a fresh project subprocess. */
export function isolateResources(cwd: string, resources: readonly McpResource[]): McpResource[] {
  return resources.map((resource) => ({ ...resource, read: () => readResource(cwd, resource.uri) }))
}

/** The app's own tools, resources and prompts, each forwarded to a project subprocess. */
export interface IsolatedSurface {
  readonly tools: readonly McpTool[]
  readonly resources: readonly McpResource[]
  readonly prompts: readonly McpPrompt[]
}

const EMPTY_SURFACE: AppSurface = { tools: [], resources: [], prompts: [] }

async function readSurface(cwd: string): Promise<IsolatedSurface> {
  const answer = await askProjectChild(cwd, { op: "surface" }, { timeoutMs: CHILD_TIMEOUT_MS })
  const surface = answer.ok && "surface" in answer ? answer.surface : EMPTY_SURFACE
  return {
    tools: surface.tools.map((tool) => ({
      ...tool,
      handler: (args, context) => callTool(cwd, tool.name, args, context),
    })),
    resources: surface.resources.map((resource) => ({
      ...resource,
      read: () => readResource(cwd, resource.uri),
    })),
    prompts: surface.prompts.map((prompt) => ({
      ...prompt,
      handler: (args) => getPrompt(cwd, prompt.name, args),
    })),
  }
}

/**
 * What the app declares on its backend (`app.tool(...)` and its resources and prompts), read in a
 * project subprocess and kept until `nifra.config.ts`, `backend/framework.ts` or `backend/app.ts`
 * changes. An app that cannot be loaded declares nothing: its absence must not withdraw the built-in
 * tools, and a broken app must not start a subprocess on every message.
 */
export function createAppSurface(cwd: string): () => Promise<IsolatedSurface> {
  let cached:
    | { readonly fingerprint: string; readonly surface: Promise<IsolatedSurface> }
    | undefined
  return async () => {
    const fingerprint = await appFingerprint(cwd).catch(() => "unreadable")
    if (cached?.fingerprint !== fingerprint) {
      cached = { fingerprint, surface: readSurface(cwd) }
    }
    return cached.surface
  }
}

/**
 * `detectMonorepo`, with the root config evaluated in a project subprocess. Only a directory with a
 * `nifra.config.ts` and no `routes/` can be a monorepo root, so no other directory starts one.
 */
export async function detectMonorepoIsolated(cwd: string): Promise<NifraMonorepoConfig | null> {
  if (!existsSync(resolve(cwd, CONFIG_FILE)) || existsSync(resolve(cwd, "routes"))) return null
  const answer = await askProjectChild(cwd, { op: "monorepo" }, { timeoutMs: CHILD_TIMEOUT_MS })
  if (!answer.ok || !("apps" in answer) || answer.apps === null) return null
  const apps = Object.entries(answer.apps).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  )
  return { apps: Object.fromEntries(apps) }
}
