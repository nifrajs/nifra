import { realpathSync } from "node:fs"
import type { ExtensionContext, ExtensionTool } from "./extensions.ts"

const modulePath = process.argv[2]
const cwd = process.argv[3]
if (modulePath === undefined || cwd === undefined)
  throw new Error("isolated extension worker: modulePath and cwd are required")

const tools = new Map<string, ExtensionTool>()
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

try {
  const module = (await import(`${realpathSync(modulePath)}?isolated=${Date.now()}`)) as {
    default?: (context: ExtensionContext) => unknown | PromiseLike<unknown>
  }
  if (typeof module.default !== "function") throw new Error("extension has no default factory")
  await module.default(context)
  post({ type: "ready" })
} catch (error) {
  post({ type: "fatal", error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
}

let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += String(chunk)
  for (;;) {
    const newline = buffer.indexOf("\n")
    if (newline < 0) return
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.length === 0) continue
    void handle(line)
  }
})

async function handle(line: string): Promise<void> {
  let request: { type?: string; id?: string; name?: string; input?: unknown }
  try {
    request = JSON.parse(line) as typeof request
  } catch {
    post({ type: "fatal", error: "invalid request JSON" })
    return
  }
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

function post(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
