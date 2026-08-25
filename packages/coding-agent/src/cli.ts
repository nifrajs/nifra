#!/usr/bin/env bun

import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import {
  CodingAgentHost,
  CodingAgentRpcServer,
  discoverExtensions,
  ExtensionHost,
  FileSessionStore,
  migrateLegacySession,
  NIFRA_AGENT_INSTRUCTIONS,
  PiBackend,
  ReplayBackend,
  readReplayEvents,
  runNifraContext,
  validateExtensionModule,
} from "./index.ts"
import { runNifraVerification } from "./verification.ts"

const HELP = `nifra-agent - local coding agent host

Usage:
  nifra-agent [--backend pi|replay] [--cwd <dir>] [--once <prompt>]
              [--json] [--no-session] [--session-dir <dir>] [--session-id <id>]
              [--verify-after-turn check,assure] [--max-repair-attempts <n>]
              [--pi <command>] [--replay <file>]
  nifra-agent --migrate-session <id> --migrate-from <dir> --migrate-to <dir> [--json]
  nifra-agent --rpc [--cwd <dir>] [--host 127.0.0.1] [--port 0] [--expose-error-stacks]

Commands in interactive mode:
  /reload       reload Pi or Nifra extensions
  /compact      compact the bounded prompt window
  /checkpoint   persist a recoverable session checkpoint
  /fork [ID]    fork the current session history
  /history [N]  show bounded persisted session history
  /check        run nifra check --json
  /assure       run nifra assure --json
  /context      inspect the current Nifra project context
  /approvals    list pending approvals
  /approve ID   approve a pending action
  /deny ID      deny a pending action
  /quit         close the session
`

export interface CliOptions {
  readonly backend: string
  readonly cwd: string
  readonly once?: string
  readonly json: boolean
  readonly noSession: boolean
  readonly piCommand: string
  readonly replayFile?: string
  readonly sessionDir?: string
  readonly rpc: boolean
  readonly host: string
  readonly port: number
  readonly authToken?: string
  readonly exposeErrorStacks: boolean
  readonly sessionId?: string
  readonly migrateSession?: string
  readonly migrationSource?: string
  readonly migrationTarget?: string
  readonly verifyAfterTurn: readonly ("check" | "assure" | "test")[]
  readonly maxRepairAttempts: number
}

export function parseArgs(args: readonly string[]): CliOptions {
  let backend = "pi"
  let cwd = process.cwd()
  let once: string | undefined
  let json = false
  let noSession = false
  let piCommand = "pi"
  let replayFile: string | undefined
  let sessionDir: string | undefined
  let rpc = false
  let host = "127.0.0.1"
  let port = 0
  let authToken: string | undefined
  let exposeErrorStacks = false
  let sessionId: string | undefined
  let migrateSession: string | undefined
  let migrationSource: string | undefined
  let migrationTarget: string | undefined
  let verifyAfterTurn: readonly ("check" | "assure" | "test")[] = []
  let maxRepairAttempts = 2
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--backend") backend = args[++index] ?? backend
    else if (arg === "--cwd") cwd = resolve(args[++index] ?? cwd)
    else if (arg === "--once" || arg === "--message") once = args[++index]
    else if (arg === "--json") json = true
    else if (arg === "--no-session") noSession = true
    else if (arg === "--session-dir") sessionDir = resolve(args[++index] ?? "")
    else if (arg === "--session-id") sessionId = args[++index]
    else if (arg === "--migrate-session") migrateSession = args[++index]
    else if (arg === "--migrate-from") migrationSource = resolve(args[++index] ?? "")
    else if (arg === "--migrate-to") migrationTarget = resolve(args[++index] ?? "")
    else if (arg === "--pi") piCommand = args[++index] ?? piCommand
    else if (arg === "--replay") replayFile = resolve(args[++index] ?? "")
    else if (arg === "--rpc") rpc = true
    else if (arg === "--host") host = args[++index] ?? host
    else if (arg === "--port") {
      port = Number(args[++index] ?? "0")
      if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
        throw new Error("--port must be an integer between 0 and 65535")
    } else if (arg === "--token") authToken = args[++index]
    else if (arg === "--expose-error-stacks") exposeErrorStacks = true
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
      console.log(HELP)
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (backend !== "pi" && backend !== "replay") throw new Error(`unsupported backend: ${backend}`)
  if (backend === "replay" && replayFile === undefined)
    throw new Error("--backend replay requires --replay <file>")
  if (
    migrateSession === undefined &&
    (migrationSource !== undefined || migrationTarget !== undefined)
  )
    throw new Error("--migrate-from and --migrate-to require --migrate-session")
  if (
    migrateSession !== undefined &&
    (migrationSource === undefined || migrationTarget === undefined)
  )
    throw new Error("--migrate-session requires --migrate-from and --migrate-to")
  return {
    backend,
    cwd,
    ...(once === undefined ? {} : { once }),
    json,
    noSession,
    piCommand,
    ...(replayFile === undefined ? {} : { replayFile }),
    ...(sessionDir === undefined ? {} : { sessionDir }),
    rpc,
    host,
    port,
    ...(authToken === undefined ? {} : { authToken }),
    exposeErrorStacks,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(migrateSession === undefined ? {} : { migrateSession }),
    ...(migrationSource === undefined ? {} : { migrationSource }),
    ...(migrationTarget === undefined ? {} : { migrationTarget }),
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

function printEvent(event: AgentEvent, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(event))
    return
  }
  if (event.type === "assistant.delta") process.stdout.write(String(event.text ?? ""))
  else if (event.type === "assistant.message")
    process.stdout.write(`\n${String(event.text ?? "")}\n`)
  else if (event.type === "tool.started")
    console.error(`\n[tool] ${String(event.name ?? "unknown")}`)
  else if (event.type === "tool.completed")
    console.error(`[tool ${event.ok === true ? "ok" : "failed"}]`)
  else if (event.type === "memory.compacted")
    console.error(`[memory] compacted ${String(event.before)} -> ${String(event.after)}`)
  else if (event.type === "extension.reloaded") console.error(`[reload] ${String(event.revision)}`)
  else if (event.type === "session.failed") console.error(`[agent] ${JSON.stringify(event.error)}`)
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2))
  if (options.migrateSession !== undefined) {
    const report = await migrateLegacySession({
      sessionId: options.migrateSession,
      sourceRoot: options.migrationSource!,
      targetRoot: options.migrationTarget!,
    })
    if (options.json) console.log(JSON.stringify({ type: "session.migrated", report }))
    else
      console.log(
        `[session] migrated ${report.records} evidence records (${report.firstSeq ?? "empty"}..${report.lastSeq ?? "empty"}) digest ${report.digest}`,
      )
    return
  }
  const backend =
    options.backend === "replay"
      ? new ReplayBackend({ events: await readReplayEvents(options.replayFile!) })
      : new PiBackend({
          command: options.piCommand,
          noSession: options.noSession,
          appendSystemPrompt: NIFRA_AGENT_INSTRUCTIONS,
          enableNifraTools: true,
          ...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
        })
  const extensionRoots = await discoverExtensions(options.cwd)
  const extensions = new ExtensionHost({
    cwd: options.cwd,
    roots: extensionRoots,
    validate: validateExtensionModule,
  })

  if (options.rpc) {
    const rpc = new CodingAgentRpcServer({
      backend,
      cwd: options.cwd,
      hostname: options.host,
      port: options.port,
      ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
      exposeErrorStacks: options.exposeErrorStacks,
      ...(options.sessionDir === undefined
        ? {}
        : { sessionStore: new FileSessionStore({ root: join(options.sessionDir, "events") }) }),
      extensions,
      maxRepairAttempts: options.maxRepairAttempts,
      verifyAfterTurn: options.verifyAfterTurn,
    })
    const handle = await rpc.start()
    const ready = { type: "rpc.ready", url: handle.url, token: handle.token, protocol: 1 }
    if (options.json) console.log(JSON.stringify(ready))
    else console.error(`nifra-agent RPC listening at ${handle.url} (token: ${handle.token})`)
    const stopRpc = async (code: number): Promise<void> => {
      await rpc.stop()
      process.exit(code)
    }
    process.once("SIGINT", () => void stopRpc(130))
    process.once("SIGTERM", () => void stopRpc(143))
    await new Promise<void>(() => {})
    return
  }

  const hostOptions =
    options.sessionDir === undefined
      ? {
          backend,
          extensions,
          maxRepairAttempts: options.maxRepairAttempts,
          verifyAfterTurn: options.verifyAfterTurn,
        }
      : {
          backend,
          sessionStore: new FileSessionStore({ root: join(options.sessionDir, "events") }),
          extensions,
          maxRepairAttempts: options.maxRepairAttempts,
          verifyAfterTurn: options.verifyAfterTurn,
        }
  const host = new CodingAgentHost(hostOptions)
  await host.start({
    cwd: options.cwd,
    backend: options.backend,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  })
  const stop = async (): Promise<void> => {
    await host.stop("process exit")
  }
  process.once("SIGINT", () => void stop().finally(() => process.exit(130)))
  process.once("SIGTERM", () => void stop().finally(() => process.exit(143)))

  const send = async (message: string): Promise<void> => {
    for await (const event of host.prompt(message)) printEvent(event, options.json)
  }

  if (options.once !== undefined) {
    await send(options.once)
    await stop()
    return
  }

  if (!options.json) {
    console.log("nifra-agent connected to Pi. Type a prompt, /reload, /check, or /quit.")
  }
  const readline = createInterface({
    input: process.stdin,
    output: options.json ? undefined : process.stdout,
  })
  try {
    for await (const line of readline) {
      const message = line.trim()
      if (message.length === 0) continue
      if (message === "/quit" || message === "/exit") break
      if (message === "/reload") {
        const result = await host.reload()
        if (options.json) console.log(JSON.stringify({ type: "extension.reloaded", ...result }))
        else console.error(`[reload] ${result.rolledBack ? "rolled back" : result.revision}`)
        continue
      }
      if (message === "/compact") {
        const result = await host.compact("manual")
        if (options.json) console.log(JSON.stringify({ type: "memory.compacted", ...result }))
        else console.error(`[memory] compacted ${result.before} -> ${result.after}`)
        continue
      }
      if (message === "/checkpoint") {
        await host.checkpoint()
        if (options.json) console.log(JSON.stringify({ type: "session.checkpoint", ok: true }))
        else console.error("[session] checkpoint saved")
        continue
      }
      const forkCommand = /^\/fork(?:\s+([^\s]+))?$/.exec(message)
      if (forkCommand !== null) {
        const result = await host.fork(forkCommand[1])
        if (options.json) console.log(JSON.stringify({ type: "session.forked", ...result }))
        else console.log(`[session] forked ${result.sessionId}`)
        continue
      }
      const historyCommand = /^\/history(?:\s+(\d+))?$/.exec(message)
      if (historyCommand !== null) {
        const result = await host.history(
          historyCommand[1] === undefined ? 20 : Number(historyCommand[1]),
        )
        if (options.json) console.log(JSON.stringify({ type: "session.history", entries: result }))
        else for (const entry of result) console.log(`${entry.seq} · ${entry.type}`)
        continue
      }
      if (message === "/check") {
        const result = await runNifraVerification("check", { cwd: options.cwd })
        if (options.json) console.log(JSON.stringify({ type: "verification.completed", ...result }))
        else
          console.error(
            `[check] ${result.ok ? "passed" : "failed"}${result.status === null ? "" : ` (exit ${result.status})`}`,
          )
        continue
      }
      if (message === "/assure") {
        const result = await runNifraVerification("assure", { cwd: options.cwd })
        if (options.json) console.log(JSON.stringify({ type: "verification.completed", ...result }))
        else
          console.error(
            `[assure] ${result.ok ? "passed" : "failed"}${result.status === null ? "" : ` (exit ${result.status})`}`,
          )
        continue
      }
      if (message === "/context") {
        const result = await runNifraContext({ cwd: options.cwd })
        if (options.json) console.log(JSON.stringify({ type: "context.completed", ...result }))
        else console.log(result.output ?? JSON.stringify(result.report ?? result))
        continue
      }
      if (message === "/approvals") {
        const result = host.pendingApprovals
        if (options.json) console.log(JSON.stringify({ type: "approval.list", pending: result }))
        else if (result.length === 0) console.log("No pending approvals")
        else
          for (const approval of result)
            console.log(`${approval.id} · ${approval.capability} · ${approval.action}`)
        continue
      }
      const approvalCommand = /^(\/approve|\/deny)\s+([^\s]+)$/.exec(message)
      if (approvalCommand !== null) {
        const result = await host.resolveApproval(
          approvalCommand[2]!,
          approvalCommand[1] === "/approve",
          "CLI decision",
        )
        if (options.json)
          console.log(
            JSON.stringify({
              type: "approval.resolved",
              ...(result ?? { error: "approval not found" }),
            }),
          )
        else
          console.log(
            result === undefined
              ? "Approval not found"
              : `${result.approved ? "Approved" : "Denied"} ${result.approvalId}`,
          )
        continue
      }
      await send(message)
    }
  } finally {
    readline.close()
    await stop()
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
