/**
 * The subprocess `nifra mcp` runs project code in. The server (`mcp-isolate.ts`) spawns a fresh one
 * per call in the project's directory, so Bun loads that directory's `.env` files here, and the
 * config, the backend and everything they import run here and exit with the process. The tools,
 * resources and prompts answered here are the same ones the server lists: the project tools, and the
 * ones the app declares on its backend.
 *
 * Protocol: one JSON request on stdin; on stdout, progress lines and then one answer line, each
 * prefixed with the request's token, so anything project code prints cannot be read as an answer.
 */

import { detectMonorepo } from "./load.ts"
import { projectResources } from "./mcp-context.ts"
import { createCachedAppLoader, projectTools } from "./mcp-exec.ts"
import { CHILD_INPUT_MAX_BYTES, readBoundedStream } from "./mcp-io.ts"
import type {
  McpPrompt,
  McpPromptMessage,
  McpResource,
  McpTool,
  McpToolResult,
} from "./mcp-protocol.ts"
import {
  extractBackendPrompts,
  extractBackendResources,
  extractBackendTools,
} from "./mcp-reflect.ts"

export type ProjectChildRequest =
  | { readonly op: "monorepo" }
  | { readonly op: "surface" }
  | { readonly op: "tool"; readonly name: string; readonly args: Record<string, unknown> }
  | { readonly op: "resource"; readonly uri: string }
  | { readonly op: "prompt"; readonly name: string; readonly args: Record<string, unknown> }

/** What the server lists for the tools, resources and prompts the app declares on its backend. */
export interface AppSurface {
  readonly tools: readonly Omit<McpTool, "handler">[]
  readonly resources: readonly Omit<McpResource, "read">[]
  readonly prompts: readonly Omit<McpPrompt, "handler">[]
}

export type ProjectChildAnswer =
  | { readonly ok: true; readonly apps: Readonly<Record<string, string>> | null }
  | { readonly ok: true; readonly surface: AppSurface }
  | { readonly ok: true; readonly result: string | McpToolResult }
  | { readonly ok: true; readonly resource: { readonly text: string; readonly mimeType?: string } }
  | { readonly ok: true; readonly messages: readonly McpPromptMessage[] }
  | { readonly ok: false; readonly message: string }

export type ProjectChildMessage =
  | { readonly type: "progress"; readonly progress: number; readonly total?: number }
  | { readonly type: "answer"; readonly answer: ProjectChildAnswer }

/**
 * Answer `request` for the project at `cwd`. A tool, resource or prompt that throws answers
 * `ok: false` with its message; an app that cannot be loaded declares nothing, as in the server.
 */
export async function answerProjectRequest(
  cwd: string,
  request: ProjectChildRequest,
  reportProgress: (progress: number, total?: number) => void = () => {},
): Promise<ProjectChildAnswer> {
  try {
    if (request.op === "monorepo") {
      return { ok: true, apps: (await detectMonorepo(cwd))?.apps ?? null }
    }
    const loadAppCached = createCachedAppLoader(cwd)
    const backend = (): Promise<unknown> =>
      loadAppCached().then(
        (app) => app.backend,
        () => undefined,
      )
    if (request.op === "surface") {
      const declared = await backend()
      return {
        ok: true,
        surface: {
          tools: extractBackendTools(declared),
          resources: extractBackendResources(declared),
          prompts: extractBackendPrompts(declared),
        },
      }
    }
    if (request.op === "tool") {
      const tool =
        projectTools(cwd, loadAppCached).find((t) => t.name === request.name) ??
        extractBackendTools(await backend()).find((t) => t.name === request.name)
      if (tool === undefined) return { ok: false, message: `unknown tool: ${request.name}` }
      const result = await tool.handler(request.args, {
        signal: new AbortController().signal,
        requestId: null,
        reportProgress,
      })
      return { ok: true, result }
    }
    if (request.op === "resource") {
      const resource =
        projectResources(cwd, loadAppCached).find((r) => r.uri === request.uri) ??
        extractBackendResources(await backend()).find((r) => r.uri === request.uri)
      if (resource === undefined) return { ok: false, message: `unknown resource: ${request.uri}` }
      return { ok: true, resource: await resource.read() }
    }
    const prompt = extractBackendPrompts(await backend()).find((p) => p.name === request.name)
    if (prompt === undefined) return { ok: false, message: `unknown prompt: ${request.name}` }
    return { ok: true, messages: await prompt.handler(request.args) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

const isArgs = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function parseRequest(text: string): { token: string; request: ProjectChildRequest } | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isArgs(value)) return undefined
  const { token, op, name, uri, args } = value
  if (typeof token !== "string" || !/^[0-9a-f-]{16,64}$/.test(token)) return undefined
  if (op === "monorepo" || op === "surface") return { token, request: { op } }
  if (op === "resource" && typeof uri === "string") return { token, request: { op, uri } }
  if ((op === "tool" || op === "prompt") && typeof name === "string" && isArgs(args)) {
    return { token, request: { op, name, args } }
  }
  return undefined
}

/**
 * Serve one request: read it from `input`, answer it and write each message through `write`,
 * prefixed with the request's token. Returns false (writing nothing) for a malformed request.
 */
export async function serveProjectChild(
  cwd: string,
  input: ReadableStream<Uint8Array>,
  write: (line: string) => Promise<void>,
): Promise<boolean> {
  const text = await readBoundedStream(input, CHILD_INPUT_MAX_BYTES)
  const parsed = text.truncated ? undefined : parseRequest(text.text)
  if (parsed === undefined) return false
  const send = (message: ProjectChildMessage): Promise<void> =>
    write(`${parsed.token} ${JSON.stringify(message)}\n`)
  const answer = await answerProjectRequest(cwd, parsed.request, (progress, total) => {
    void send(
      total === undefined ? { type: "progress", progress } : { type: "progress", progress, total },
    )
  })
  let line: string
  try {
    line = JSON.stringify({ type: "answer", answer } satisfies ProjectChildMessage)
  } catch {
    line = JSON.stringify({
      type: "answer",
      answer: { ok: false, message: "the answer is not serializable" },
    } satisfies ProjectChildMessage)
  }
  await write(`${parsed.token} ${line}\n`)
  return true
}

if (import.meta.main) {
  // Bound before project code loads, so nothing it patches can reach the protocol channel.
  const stdout = process.stdout.write.bind(process.stdout)
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((arg) => String(arg)).join(" ")}\n`)
  }
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
  const served = await serveProjectChild(
    process.argv[2] ?? process.cwd(),
    Bun.stdin.stream(),
    (line) => new Promise((done) => stdout(line, () => done())),
  )
  if (!served) process.stderr.write("nifra mcp: invalid project request\n")
  // Project code may leave a handle open (a pool, an interval); the answer is written, so stop here.
  process.exit(served ? 0 : 2)
}
