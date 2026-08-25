import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentBackend, AgentEvent } from "@nifrajs/agent-protocol"
import {
  CodingAgentRpcServer,
  type CodingAgentRpcServerOptions,
  discoverExtensions,
  ExtensionHost,
  FileSessionStore,
  NIFRA_AGENT_INSTRUCTIONS,
  PiBackend,
  ReplayBackend,
  UiExtensionHost,
  validateExtensionModule,
} from "@nifrajs/coding-agent"

type BackendMode = "pi" | "replay"

interface WorkbenchOptions {
  readonly cwd: string
  readonly uiPort: number
  readonly rpcPort: number
  readonly piCommand: string
  readonly backend: BackendMode
  readonly verifyAfterTurn: readonly ("check" | "assure" | "test")[]
  readonly maxRepairAttempts: number
}

const options = parseArgs(Bun.argv.slice(2))
const rpc = await buildRpcServer(options)
const rpcHandle = await rpc.start()

// Assets ship from dist/public so the same origin serves the built browser bundle in dev and prod.
// packageRoot resolves to the workbench package whether this module runs from src/ or the built dist/.
const packageRoot = join(import.meta.dir, "..")
const htmlPath = join(packageRoot, "dist/public/index.html")
const scriptPath = join(packageRoot, "dist/public/app.js")

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
console.log(`Backend: ${options.backend}`)

const stop = async (code: number): Promise<void> => {
  ui.stop(true)
  await rpc.stop()
  process.exit(code)
}
process.once("SIGINT", () => void stop(130))
process.once("SIGTERM", () => void stop(143))
await new Promise<void>(() => {})

/** Assemble the RPC server for the selected backend. The replay backend needs no Pi process, so it
 * boots CI and demo sessions from a fixed fixture without touching the filesystem or a model. */
async function buildRpcServer(opts: WorkbenchOptions): Promise<CodingAgentRpcServer> {
  const base: CodingAgentRpcServerOptions = {
    backend: opts.backend === "replay" ? replayBackend() : piBackend(opts),
    cwd: opts.cwd,
    hostname: "127.0.0.1",
    port: opts.rpcPort,
    maxRepairAttempts: opts.maxRepairAttempts,
    verifyAfterTurn: opts.verifyAfterTurn,
  }
  if (opts.backend === "replay") return new CodingAgentRpcServer(base)
  const extensionRoots = await discoverExtensions(opts.cwd)
  return new CodingAgentRpcServer({
    ...base,
    extensions: new ExtensionHost({
      cwd: opts.cwd,
      roots: extensionRoots,
      validate: validateExtensionModule,
    }),
    ui: new UiExtensionHost(),
    sessionStore: new FileSessionStore({ root: join(opts.cwd, ".nifra/agent-sessions") }),
  })
}

function piBackend(opts: WorkbenchOptions): AgentBackend {
  return new PiBackend({
    command: opts.piCommand,
    noSession: false,
    appendSystemPrompt: NIFRA_AGENT_INSTRUCTIONS,
    enableNifraTools: true,
  })
}

function replayBackend(): AgentBackend {
  const sessionId = "replay-demo"
  const turnId = "turn-1"
  const base = { version: 1, sessionId } as const
  const events: readonly AgentEvent[] = [
    { ...base, seq: 1, at: 1, type: "turn.started", turnId, prompt: "inspect the project" },
    { ...base, seq: 2, at: 2, type: "assistant.delta", turnId, text: "Inspecting the project" },
    {
      ...base,
      seq: 3,
      at: 3,
      type: "tool.started",
      turnId,
      callId: "call-1",
      name: "read_file",
      input: { path: "README.md" },
    },
    {
      ...base,
      seq: 4,
      at: 4,
      type: "tool.completed",
      turnId,
      callId: "call-1",
      name: "read_file",
      ok: true,
    },
    { ...base, seq: 5, at: 5, type: "assistant.message", turnId, text: "Done. No changes needed." },
  ]
  return new ReplayBackend({ events, delayMs: 10 })
}

function parseArgs(args: readonly string[]): WorkbenchOptions {
  let cwd = process.cwd()
  let uiPort = 0
  let rpcPort = 0
  let piCommand = "pi"
  let backend: BackendMode = "pi"
  let verifyAfterTurn: readonly ("check" | "assure" | "test")[] = []
  let maxRepairAttempts = 2
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--cwd") cwd = resolvePath(args[++index] ?? cwd)
    else if (arg === "--ui-port") uiPort = parsePort(args[++index], "--ui-port")
    else if (arg === "--rpc-port") rpcPort = parsePort(args[++index], "--rpc-port")
    else if (arg === "--pi") piCommand = args[++index] ?? piCommand
    else if (arg === "--backend") backend = parseBackend(args[++index])
    else if (arg === "--verify-after-turn")
      verifyAfterTurn = parseVerificationNames(args[++index] ?? "")
    else if (arg === "--max-repair-attempts") {
      maxRepairAttempts = Number(args[++index] ?? "")
      if (
        !Number.isSafeInteger(maxRepairAttempts) ||
        maxRepairAttempts < 0 ||
        maxRepairAttempts > 8
      )
        throw new Error("--max-repair-attempts must be an integer between 0 and 8")
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "nifra-workbench [--cwd <dir>] [--ui-port <port>] [--rpc-port <port>] [--pi <command>] [--backend pi|replay] [--verify-after-turn check,assure,test] [--max-repair-attempts <n>]",
      )
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return {
    cwd,
    uiPort,
    rpcPort,
    piCommand,
    backend,
    verifyAfterTurn,
    maxRepairAttempts,
  }
}

function parseVerificationNames(value: string): readonly ("check" | "assure" | "test")[] {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  if (
    names.length === 0 ||
    names.some((name) => name !== "check" && name !== "assure" && name !== "test")
  )
    throw new Error("--verify-after-turn must contain only check, assure, or test")
  return Object.freeze([...new Set(names)] as ("check" | "assure" | "test")[])
}

function parseBackend(value: string | undefined): BackendMode {
  if (value === "pi" || value === "replay") return value
  throw new Error("--backend must be pi or replay")
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
