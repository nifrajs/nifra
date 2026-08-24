import { realpathSync } from "node:fs"
import type { ExtensionContext, ExtensionTool } from "./extensions.ts"

const modulePath = process.argv[2]
const cwd = process.argv[3]
if (modulePath === undefined || cwd === undefined)
  throw new Error("isolated extension worker: modulePath and cwd are required")

const tools = new Map<string, ExtensionTool>()
let ready = false
interface WorkerRequest {
  readonly type?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly input?: unknown
}

const queuedRequests: WorkerRequest[] = []
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

// The host starts sending immediately after `ready`; attach before the async extension import so
// the first request is queued until the extension has registered its tools.
process.on("message", (message: unknown) => {
  if (!isWorkerRequest(message)) {
    post({ type: "fatal", error: "invalid worker IPC message" })
    return
  }
  if (ready) void handle(message)
  else queuedRequests.push(message)
})

try {
  const module = (await import(`${realpathSync(modulePath)}?isolated=${Date.now()}`)) as {
    default?: (context: ExtensionContext) => unknown | PromiseLike<unknown>
  }
  if (typeof module.default !== "function") throw new Error("extension has no default factory")
  await module.default(context)
  post({ type: "ready" })
  ready = true
  for (const line of queuedRequests.splice(0)) void handle(line)
} catch (error) {
  post({ type: "fatal", error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
}

async function handle(request: WorkerRequest): Promise<void> {
  if (request.type === "shutdown") {
    process.exit(0)
    return
  }
  if (
    request.type !== "invoke" ||
    typeof request.id !== "string" ||
    typeof request.name !== "string"
  )
    return
  const tool = tools.get(request.name)
  if (tool === undefined) {
    post({ type: "result", id: request.id, error: `unknown tool: ${request.name}` })
    return
  }
  try {
    const output = await tool.execute(request.input, context)
    post({ type: "result", id: request.id, output })
  } catch (error) {
    post({
      type: "result",
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function isWorkerRequest(message: unknown): message is WorkerRequest {
  return message !== null && typeof message === "object" && !Array.isArray(message)
}

function post(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
