#!/usr/bin/env bun
/** Run the Workers adapter's contract witnesses against a real local workerd process. */
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  certifyAdapter,
  defineCertificationProfile,
} from "../packages/testing/src/certification.ts"
import {
  createReferenceContractLabHandler,
  runContractLabOverHttp,
} from "../packages/testing/src/contract-lab.ts"

const ROOT = resolve(import.meta.dir, "..")
const CONFIG = join(ROOT, "packages/workers/test/workerd/wrangler.toml")
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler")
const REQUESTED_PORT = process.env.NIFRA_WORKERD_PORT
let PORT = Number(REQUESTED_PORT ?? 0)
let ORIGIN = ""
const READY_TIMEOUT_MS = 45_000

if (!existsSync(WRANGLER)) {
  throw new Error("wrangler is not installed; run `bun install` before check:workerd")
}

async function assertPortFree(port: number): Promise<void> {
  let listener: ReturnType<typeof Bun.serve> | undefined
  try {
    listener = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => new Response(null, { status: 204 }),
    })
  } catch (error) {
    throw new Error(
      `workerd port ${port} is not free: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    listener?.stop(true)
  }
}

async function choosePort(): Promise<number> {
  if (REQUESTED_PORT !== undefined) {
    if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535)
      throw new Error(`invalid NIFRA_WORKERD_PORT: ${REQUESTED_PORT}`)
    await assertPortFree(PORT)
    return PORT
  }
  for (let candidate = 8787; candidate < 8887; candidate++) {
    let listener: ReturnType<typeof Bun.serve> | undefined
    try {
      listener = Bun.serve({
        hostname: "127.0.0.1",
        port: candidate,
        fetch: () => new Response(null, { status: 204 }),
      })
      return candidate
    } catch {
      // Try the next local candidate; the final assertion still catches a race before Wrangler starts.
    } finally {
      listener?.stop(true)
    }
  }
  throw new Error("could not find a free local port for workerd")
}

function waitForExit(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode ?? 1)
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit(code ?? (signal === null ? 1 : 143)))
  })
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/pid", String(child.pid), "/T", "/F"])
    return
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
}

async function waitForReady(child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited before readiness:\n${output()}`)
    try {
      await fetch(`${ORIGIN}/__nifra_ready__`, { signal: AbortSignal.timeout(750) })
      return
    } catch {
      await Bun.sleep(150)
    }
  }
  throw new Error(`timed out waiting for wrangler at ${ORIGIN}:\n${output()}`)
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for WebSocket message")),
      5_000,
    )
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer)
        resolveMessage(typeof event.data === "string" ? event.data : String(event.data))
      },
      { once: true },
    )
  })
}

interface WorkerdCertificationAdapter {
  readonly origin: string
}

const workerdCertificationProfile = defineCertificationProfile<WorkerdCertificationAdapter>({
  id: "workers-workerd",
  version: 1,
  capabilities: ["contract-lab", "durable-object-state", "websocket-broadcast"],
  checks: [
    {
      id: "contract-lab",
      capability: "contract-lab",
      target: { witnessKind: "contract-lab" },
      run: (adapter) => runContractLabOverHttp(adapter.origin),
    },
    {
      id: "durable-object-state",
      capability: "durable-object-state",
      target: { witnessKind: "durable-object" },
      async run(adapter, context) {
        const value = context.key("state")
        const stateMutation = await fetch(`${adapter.origin}/state`, {
          method: "POST",
          headers: { "content-type": "application/json", connection: "close" },
          body: JSON.stringify({ value }),
        })
        if (stateMutation.status !== 200)
          throw new Error(`DurableObjectStateMutation${stateMutation.status}`)
        await stateMutation.arrayBuffer()

        const stateRead = await fetch(`${adapter.origin}/state?reconnect=1`, {
          headers: { connection: "close" },
        })
        const stateValue = (await stateRead.json()) as { value?: unknown }
        if (stateRead.status !== 200 || stateValue.value !== value)
          throw new Error("DurableObjectStatePersistence")
      },
    },
    {
      id: "websocket-broadcast",
      capability: "websocket-broadcast",
      target: { witnessKind: "websocket" },
      async run(adapter, context) {
        const first = await openWebSocketAt(adapter.origin, "/room")
        const second = await openWebSocketAt(adapter.origin, "/room")
        try {
          const firstMessage = nextMessage(first)
          const secondMessage = nextMessage(second)
          const payload = context.key("fanout")
          first.send(payload)
          const received = await Promise.all([firstMessage, secondMessage])
          if (received[0] !== payload || received[1] !== payload)
            throw new Error("DurableObjectWebSocketBroadcast")
        } finally {
          first.close()
          second.close()
        }
      },
    },
  ],
})

function openWebSocketAt(origin: string, path: string): Promise<WebSocket> {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(`${origin}${path}`)
    const fail = () => reject(new Error(`WebSocketOpen${path.replaceAll("/", "_")}`))
    socket.addEventListener("open", () => resolveSocket(socket), { once: true })
    socket.addEventListener("error", fail, { once: true })
  })
}

async function runBunContractLab(): Promise<void> {
  const handler = createReferenceContractLabHandler()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => handler.fetch(request),
  })
  try {
    await runContractLabOverHttp(server.url.origin)
  } finally {
    server.stop(true)
  }
}

PORT = await choosePort()
ORIGIN = `http://127.0.0.1:${PORT}`
await assertPortFree(PORT)
const persist = mkdtempSync(join(tmpdir(), "nifra-workerd-"))
mkdirSync(persist, { recursive: true })
// Keep Wrangler's logs, registry, and config inside the disposable test sandbox.
const wranglerConfig = join(persist, "config")
const wranglerCache = join(persist, "cache")
const wranglerRegistry = join(persist, "registry")
mkdirSync(wranglerConfig, { recursive: true })
mkdirSync(wranglerCache, { recursive: true })
mkdirSync(wranglerRegistry, { recursive: true })
const child = spawn(
  WRANGLER,
  [
    "dev",
    "--config",
    CONFIG,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(PORT),
    "--persist-to",
    persist,
    "--log-level",
    "error",
    "--show-interactive-dev-session=false",
  ],
  {
    cwd: ROOT,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: wranglerConfig,
      XDG_CACHE_HOME: wranglerCache,
      WRANGLER_REGISTRY_PATH: wranglerRegistry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
)
let logs = ""
const capture = (chunk: Buffer): void => {
  logs = `${logs}${chunk.toString()}`.slice(-20_000)
}
child.stdout?.on("data", capture)
child.stderr?.on("data", capture)
try {
  await runBunContractLab()
  await waitForReady(child, () => logs)
  const report = await certifyAdapter({
    profile: workerdCertificationProfile,
    adapterId: "workers-workerd",
    target: {
      adapter: "@nifrajs/workers",
      runtime: "workerd",
      artifact: "packages/workers/test/workerd/worker.ts",
      source: "packages/workers/src/index.ts",
    },
    createAdapter: () => ({ origin: ORIGIN }),
  })
  if (!report.ok) {
    console.error(JSON.stringify(report, null, 2))
    throw new Error(`workerd certification failed: ${report.evidenceHash}`)
  }
  console.log(
    `✓ workerd certification passed ${report.capabilities.length} capabilities (${report.evidenceHash})`,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(logs)
  process.exitCode = 1
} finally {
  killTree(child)
  await waitForExit(child).catch(() => undefined)
  rmSync(persist, { recursive: true, force: true })
}
