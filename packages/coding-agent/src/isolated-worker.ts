import { realpathSync } from "node:fs"
import { publicErrorDetails } from "./errors.ts"
import type { ExtensionContext, ExtensionTool } from "./extensions.ts"
import { readBoundedText } from "./process.ts"

const modulePath = process.argv[2]
const cwd = process.argv[3]
if (modulePath === undefined || cwd === undefined)
  throw new Error("isolated extension worker: modulePath and cwd are required")

const token = process.env.NIFRA_EXTENSION_TOKEN
const maxMessageBytes = Number(process.env.NIFRA_EXTENSION_MAX_MESSAGE_BYTES)
const exposeErrorStacks = process.env.NIFRA_EXTENSION_EXPOSE_ERROR_STACKS === "1"
if (
  token === undefined ||
  token.length < 32 ||
  !Number.isSafeInteger(maxMessageBytes) ||
  maxMessageBytes < 1024
) {
  post({ type: "fatal", error: "isolated extension worker: invalid control configuration" })
  process.exit(1)
}

const tools = new Map<string, ExtensionTool>()
let ready = false
interface WorkerRequest {
  readonly type?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly input?: unknown
}

interface WorkerResult {
  readonly type: "result"
  readonly id: string
  readonly error?: string
  readonly stack?: string
  readonly output?: unknown
}

const context: ExtensionContext = {
  cwd,
  registerCommand(name) {
    post({ type: "command", name })
  },
  registerTool(tool) {
    tools.set(tool.name, tool)
    post({
      type: "registration",
      name: tool.name,
      description: tool.description,
      capabilities: tool.capabilities ?? [],
    })
  },
  registerWorkflow(name) {
    post({ type: "workflow", name })
  },
  registerSubagent(role) {
    post({ type: "subagent", name: role.name })
  },
  registerProvider(provider) {
    post({ type: "provider", name: provider.name })
  },
  on(event) {
    post({ type: "event", name: event })
  },
}

let server: ReturnType<typeof Bun.serve> | undefined

try {
  // Bind only to loopback and require the per-worker token. The endpoint is a transport seam, not
  // a security boundary: the extension already executes inside this process by design.
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/invoke")
        return new Response("", { status: 404 })
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return new Response("", { status: 401 })
      const body = await readBoundedText(request.body, maxMessageBytes)
      if (body.truncated) return new Response("", { status: 413 })
      let message: unknown
      try {
        message = JSON.parse(body.text)
      } catch {
        return new Response("", { status: 400 })
      }
      if (!isWorkerRequest(message) || message.type !== "invoke")
        return new Response("", { status: 400 })
      if (!ready) return new Response("", { status: 503 })
      const result = await handle(message)
      return result === undefined ? new Response("", { status: 400 }) : jsonResponse(result)
    },
  })
  const module = (await import(`${realpathSync(modulePath)}?isolated=${Date.now()}`)) as {
    default?: (context: ExtensionContext) => unknown | PromiseLike<unknown>
  }
  if (typeof module.default !== "function") throw new Error("extension has no default factory")
  await module.default(context)
  post({ type: "ready", port: server.port })
  ready = true
} catch (error) {
  server?.stop()
  const details = publicErrorDetails(
    error,
    "isolated extension worker failed to start",
    exposeErrorStacks,
  )
  post({
    type: "fatal",
    error: details.message,
    ...(details.stack === undefined ? {} : { stack: details.stack }),
  })
  process.exit(1)
}

async function handle(request: WorkerRequest): Promise<WorkerResult | undefined> {
  if (request.type === "shutdown") {
    server?.stop()
    process.exit(0)
    return undefined
  }
  if (
    request.type !== "invoke" ||
    typeof request.id !== "string" ||
    typeof request.name !== "string"
  )
    return undefined
  const tool = tools.get(request.name)
  if (tool === undefined) {
    return { type: "result", id: request.id, error: `unknown tool: ${request.name}` }
  }
  try {
    const output = await tool.execute(request.input, context)
    return { type: "result", id: request.id, output }
  } catch (error) {
    const details = publicErrorDetails(error, "tool execution failed", exposeErrorStacks)
    return {
      type: "result",
      id: request.id,
      error: details.message,
      ...(details.stack === undefined ? {} : { stack: details.stack }),
    }
  }
}

function isWorkerRequest(message: unknown): message is WorkerRequest {
  return message !== null && typeof message === "object" && !Array.isArray(message)
}

function jsonResponse(message: WorkerResult): Response {
  let text: string
  try {
    text = JSON.stringify(
      message,
      exposeErrorStacks
        ? undefined
        : (key: string, nested: unknown) => (key === "stack" ? undefined : nested),
    )
  } catch {
    text = JSON.stringify({ type: "result", id: message.id, error: "tool output is not JSON-safe" })
  }
  if (Buffer.byteLength(text, "utf8") > maxMessageBytes)
    text = JSON.stringify({ type: "result", id: message.id, error: "tool output is too large" })
  // lgtm [js/stack-trace-exposure] stacks are emitted only when the parent explicitly enables local
  // diagnostics; the default protocol response contains only the bounded public message.
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function post(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
