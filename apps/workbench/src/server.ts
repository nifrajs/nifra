import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  CodingAgentRpcServer,
  discoverExtensions,
  ExtensionHost,
  FileSessionStore,
  NIFRA_AGENT_INSTRUCTIONS,
  PiBackend,
  UiExtensionHost,
  validateExtensionModule,
} from "@nifrajs/coding-agent"

interface WorkbenchOptions {
  readonly cwd: string
  readonly uiPort: number
  readonly rpcPort: number
  readonly piCommand: string
}

const options = parseArgs(Bun.argv.slice(2))
const extensionRoots = await discoverExtensions(options.cwd)
const rpc = new CodingAgentRpcServer({
  backend: new PiBackend({
    command: options.piCommand,
    noSession: false,
    appendSystemPrompt: NIFRA_AGENT_INSTRUCTIONS,
    enableNifraTools: true,
  }),
  cwd: options.cwd,
  hostname: "127.0.0.1",
  port: options.rpcPort,
  extensions: new ExtensionHost({
    cwd: options.cwd,
    roots: extensionRoots,
    validate: validateExtensionModule,
  }),
  ui: new UiExtensionHost(),
  sessionStore: new FileSessionStore({ root: join(options.cwd, ".nifra/agent-sessions") }),
})
const rpcHandle = await rpc.start()
const htmlPath = join(import.meta.dir, "../public/index.html")
const scriptPath = join(import.meta.dir, "../public/app.js")
const ui = Bun.serve({
  hostname: "127.0.0.1",
  port: options.uiPort,
  fetch: async (request) => {
    const path = new URL(request.url).pathname
    if (path === "/app.js")
      return new Response(await readFile(scriptPath), {
        headers: securityHeaders("text/javascript; charset=utf-8"),
      })
    if (path === "/" || path === "/index.html")
      return new Response(await readFile(htmlPath), {
        headers: securityHeaders("text/html; charset=utf-8"),
      })
    return new Response("Not found", { status: 404 })
  },
})
const workbenchUrl = `${ui.url.toString().replace(/\/$/, "")}/?rpc=${encodeURIComponent(rpcHandle.url)}&token=${encodeURIComponent(rpcHandle.token)}`
console.log(`Nifra Workbench: ${workbenchUrl}`)
console.log(`Project: ${options.cwd}`)

const stop = async (code: number): Promise<void> => {
  ui.stop(true)
  await rpc.stop()
  process.exit(code)
}
process.once("SIGINT", () => void stop(130))
process.once("SIGTERM", () => void stop(143))
await new Promise<void>(() => {})

function parseArgs(args: readonly string[]): WorkbenchOptions {
  let cwd = process.cwd()
  let uiPort = 0
  let rpcPort = 0
  let piCommand = "pi"
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--cwd") cwd = resolvePath(args[++index] ?? cwd)
    else if (arg === "--ui-port") uiPort = parsePort(args[++index], "--ui-port")
    else if (arg === "--rpc-port") rpcPort = parsePort(args[++index], "--rpc-port")
    else if (arg === "--pi") piCommand = args[++index] ?? piCommand
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "nifra-workbench [--cwd <dir>] [--ui-port <port>] [--rpc-port <port>] [--pi <command>]",
      )
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return { cwd, uiPort, rpcPort, piCommand }
}

function parsePort(value: string | undefined, name: string): number {
  const port = Number(value ?? "0")
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
    throw new Error(`${name} must be between 0 and 65535`)
  return port
}

function resolvePath(value: string): string {
  return value.startsWith("/") ? value : join(process.cwd(), value)
}

function securityHeaders(contentType: string): Headers {
  return new Headers({
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; connect-src http://127.0.0.1:* http://localhost:*; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  })
}
