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

export interface WorkbenchOptions {
  readonly cwd: string
  readonly uiPort: number
  readonly rpcPort: number
  readonly piCommand: string
  readonly backend: BackendMode
  readonly verifyAfterTurn: readonly ("check" | "assure" | "test")[]
  readonly maxRepairAttempts: number
  /** Load and run `.nifra/extensions/**` from `cwd`. That is the project's own code: off unless asked. */
  readonly extensions: boolean
}

/** Assemble the RPC server for the selected backend. */
export async function buildRpcServer(opts: WorkbenchOptions): Promise<CodingAgentRpcServer> {
  return new CodingAgentRpcServer(await rpcServerOptions(opts))
}

/** The RPC server's options. The replay backend needs no Pi process, so it boots CI and demo
 * sessions from a fixed fixture without touching the filesystem or a model. A checkout's extensions
 * are imported - their top-level code run - only when the launcher was given `--extensions`. */
export async function rpcServerOptions(
  opts: WorkbenchOptions,
): Promise<CodingAgentRpcServerOptions> {
  const base: CodingAgentRpcServerOptions = {
    backend: opts.backend === "replay" ? replayBackend() : piBackend(opts),
    cwd: opts.cwd,
    hostname: "127.0.0.1",
    port: opts.rpcPort,
    maxRepairAttempts: opts.maxRepairAttempts,
    verifyAfterTurn: opts.verifyAfterTurn,
  }
  if (opts.backend === "replay") return base
  return {
    ...base,
    ...(opts.extensions
      ? {
          extensions: new ExtensionHost({
            cwd: opts.cwd,
            roots: await discoverExtensions(opts.cwd),
            validate: validateExtensionModule,
          }),
        }
      : {}),
    ui: new UiExtensionHost(),
    sessionStore: new FileSessionStore({ root: join(opts.cwd, ".nifra/agent-sessions") }),
  }
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

export function parseArgs(args: readonly string[]): WorkbenchOptions {
  let cwd = process.cwd()
  let uiPort = 0
  let rpcPort = 0
  let piCommand = "pi"
  let backend: BackendMode = "pi"
  let verifyAfterTurn: readonly ("check" | "assure" | "test")[] = []
  let maxRepairAttempts = 2
  let extensions = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--cwd") cwd = resolvePath(args[++index] ?? cwd)
    else if (arg === "--ui-port") uiPort = parsePort(args[++index], "--ui-port")
    else if (arg === "--rpc-port") rpcPort = parsePort(args[++index], "--rpc-port")
    else if (arg === "--pi") piCommand = args[++index] ?? piCommand
    else if (arg === "--backend") backend = parseBackend(args[++index])
    else if (arg === "--extensions") extensions = true
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
        "nifra-workbench [--cwd <dir>] [--ui-port <port>] [--rpc-port <port>] [--pi <command>] [--backend pi|replay] [--verify-after-turn check,assure,test] [--max-repair-attempts <n>] [--extensions]",
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
    extensions,
  }
}

function isVerificationName(name: string): name is "check" | "assure" | "test" {
  return name === "check" || name === "assure" || name === "test"
}

function parseVerificationNames(value: string): readonly ("check" | "assure" | "test")[] {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  const steps = names.filter(isVerificationName)
  if (names.length === 0 || steps.length !== names.length)
    throw new Error("--verify-after-turn must contain only check, assure, or test")
  return Object.freeze([...new Set(steps)])
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
