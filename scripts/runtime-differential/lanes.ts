/**
 * One lane per way the differential app is served. Bun's two lanes run in this process; Node, Deno and
 * workerd each run in a child process that loads the built `dist`, the bytes an installed user runs.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { startWranglerDev } from "../wrangler-dev.ts"
import { STATIC_FILES } from "./arbitraries.ts"
import {
  exchange,
  exchangeInProcess,
  type Outcome,
  type WireRequest,
  withDeadline,
} from "./wire.ts"

export const ROOT = resolve(import.meta.dir, "../..")
const FIXTURE = join(ROOT, "scripts/fixtures/runtime-differential")

export const LANE_NAMES = ["bun-fetch", "bun-serve", "node", "deno", "workerd"] as const
export type LaneName = (typeof LANE_NAMES)[number]
export const isLaneName = (name: string): name is LaneName =>
  LANE_NAMES.some((lane) => lane === name)

export interface Lane {
  readonly name: LaneName
  send(request: WireRequest, deadlineMs: number): Promise<Outcome>
  /** The port a WebSocket client connects to; `undefined` for a lane with no socket. */
  wsPort(): Promise<number | undefined>
  /** What went wrong in the runtime itself since the last call - an exit, a rejection - or undefined. */
  fault(): string | undefined
  /** What the runtime wrote to stderr since the last call. The app's logger is silent. */
  stderr(): string
  stop(): Promise<void>
}

/** Write the static tree every lane serves. Contents are fixed, so every runtime reads the same bytes. */
export function writePublicDir(dir: string): void {
  for (const [name, content] of Object.entries(STATIC_FILES)) {
    const path = join(dir, "static", name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, typeof content === "string" ? content : patterned(content))
  }
}

/** The port a serve script prints as `{"port":N}`, or `undefined` for any other line. */
function portOf(line: string): number | undefined {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== "object" || parsed === null || !("port" in parsed)) return undefined
  return typeof parsed.port === "number" ? parsed.port : undefined
}

function patterned(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let at = 0; at < size; at++) bytes[at] = at % 251
  return bytes
}

/** `app.fetch` in this process: the lane with no HTTP parser in front of the app. */
export async function startBunFetch(publicDir: string): Promise<Lane> {
  const { createDifferentialApp, staticMount } = await import(
    "../fixtures/runtime-differential/app.ts"
  )
  const { serveStatic } = await import("@nifrajs/core/serve-static")
  const app = createDifferentialApp({ staticFiles: serveStatic(staticMount(publicDir)) })
  return inProcessLane("bun-fetch", (request) => app.fetch(request))
}

function inProcessLane(
  name: LaneName,
  handler: (request: Request) => Response | Promise<Response>,
): Lane {
  let fault: string | undefined
  return {
    name,
    async send(request, deadlineMs) {
      try {
        return await exchangeInProcess(handler, request, deadlineMs)
      } catch (error) {
        // `app.fetch` is documented never to reject; a rejection is what a runtime would turn into a crash.
        fault = `app.fetch rejected: ${error instanceof Error ? error.stack : String(error)}`
        return { kind: "closed", detail: "app.fetch rejected" }
      }
    },
    fault() {
      const reported = fault
      fault = undefined
      return reported
    },
    wsPort: async () => undefined,
    stderr: () => "",
    async stop() {},
  }
}

/** `app.listen()` - Bun.serve with the app's native route table. */
export async function startBunServe(publicDir: string): Promise<Lane> {
  const { createDifferentialApp, staticMount } = await import(
    "../fixtures/runtime-differential/app.ts"
  )
  const { serveStatic } = await import("@nifrajs/core/serve-static")
  // Host validation is opt-in on Bun; the parity lane keeps it on, as the Deno lane does.
  const app = createDifferentialApp({
    staticFiles: serveStatic(staticMount(publicDir)),
    validateHost: true,
  })
  const running = app.listen(0, { hostname: "127.0.0.1" })
  return {
    name: "bun-serve",
    send: (request, deadlineMs) => exchange(running.port, request, deadlineMs),
    wsPort: async () => running.port,
    fault: () => undefined,
    stderr: () => "",
    async stop() {
      await running.stop(true)
    },
  }
}

interface Child {
  readonly port: number
  readonly process: ChildProcess
  /** Stderr not yet reported. */
  stderr: string
  exit: string | undefined
}

/** Spawn a runtime that prints `{"port":N}` once it listens. */
async function spawnChild(
  name: LaneName,
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  readyMs: number,
): Promise<Child> {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let startup = ""
  const port = await withDeadline(
    new Promise<number | undefined>((resolvePort) => {
      let stdout = ""
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
        const line = stdout
          .split("\n")
          .slice(0, -1)
          .find((candidate) => candidate.startsWith("{"))
        if (line !== undefined) resolvePort(portOf(line))
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        startup += chunk.toString()
      })
      child.on("exit", () => resolvePort(undefined))
    }),
    readyMs,
    () => undefined,
  )
  if (port === undefined) {
    child.kill("SIGKILL")
    throw new Error(`${name} did not report a port within ${readyMs} ms:\n${startup}`)
  }
  const state: Child = { port, process: child, stderr: startup, exit: undefined }
  child.stderr?.on("data", (chunk: Buffer) => {
    state.stderr = `${state.stderr}${chunk.toString()}`.slice(-20_000)
  })
  child.on("exit", (code, signal) => {
    state.exit = `exited (code ${code}, signal ${signal})`
  })
  return state
}

/**
 * A lane on a child runtime. A runtime that dies is reported once, as a fault of the case that was
 * running, and replaced before the next case, so a shrink can reproduce the crash.
 */
async function childLane(
  name: LaneName,
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  readyMs: number,
): Promise<Lane> {
  let child = await spawnChild(name, command, args, env, readyMs)
  let reportedExit = false
  let stopping = false
  const current = async (): Promise<Child> => {
    if (child.exit !== undefined && reportedExit) {
      child = await spawnChild(name, command, args, env, readyMs)
      reportedExit = false
    }
    return child
  }
  return {
    name,
    async send(request, deadlineMs) {
      return exchange((await current()).port, request, deadlineMs)
    },
    wsPort: async () => (await current()).port,
    fault() {
      if (child.exit === undefined || reportedExit || stopping) return undefined
      reportedExit = true
      return child.exit
    },
    stderr() {
      const text = child.stderr
      child.stderr = ""
      return text
    },
    async stop() {
      stopping = true
      if (child.exit !== undefined) return
      const exited = new Promise((resolveExit) => child.process.once("exit", resolveExit))
      child.process.kill("SIGTERM")
      await exited
    },
  }
}

export function startNode(publicDir: string, nodeEnv: string): Promise<Lane> {
  return childLane(
    "node",
    process.env.NIFRA_DIFFERENTIAL_NODE ?? "node",
    [join(FIXTURE, "serve-node.ts"), publicDir],
    { NODE_ENV: nodeEnv },
    30_000,
  )
}

export function startDeno(publicDir: string, nodeEnv: string): Promise<Lane> {
  return childLane(
    "deno",
    process.env.NIFRA_DIFFERENTIAL_DENO ?? "deno",
    [
      "run",
      "--allow-net=127.0.0.1",
      "--allow-read",
      "--allow-env",
      join(FIXTURE, "serve-deno.ts"),
      publicDir,
    ],
    { NODE_ENV: nodeEnv },
    60_000,
  )
}

/** `toFetchHandler(app)` on a real local workerd, through `wrangler dev`. */
export async function startWorkerd(): Promise<Lane> {
  // Wrangler logs a Worker's uncaught error; that log is how a throw is told apart from an answer the
  // dev front gives on its own, since both are a plain-text 500. Only whole lines are handed on, so
  // an entry is never matched from the middle.
  let pending = ""
  let complete = ""
  const dev = await startWranglerDev(join(FIXTURE, "wrangler.toml"), (chunk) => {
    pending += chunk
    const end = pending.lastIndexOf("\n")
    if (end === -1) return
    complete += pending.slice(0, end + 1)
    pending = pending.slice(end + 1)
  })
  try {
    await dev.ready("/")
  } catch (error) {
    await dev.stop()
    throw error
  }
  complete = ""
  return {
    name: "workerd",
    send: (request, deadlineMs) => exchange(dev.port, request, deadlineMs),
    wsPort: async () => dev.port,
    fault: () => undefined,
    stderr() {
      const text = complete
      complete = ""
      return text
    },
    stop: () => dev.stop(),
  }
}
