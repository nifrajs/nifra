#!/usr/bin/env bun
/** Run the Workers adapter's contract witnesses against a real local workerd process. */
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

function openWebSocket(path: string): Promise<WebSocket> {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(`${ORIGIN}${path}`)
    const fail = () => reject(new Error(`WebSocket failed to open: ${path}`))
    socket.addEventListener("open", () => resolveSocket(socket), { once: true })
    socket.addEventListener("error", fail, { once: true })
  })
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

async function runWorkersWitnesses(): Promise<void> {
  const stateMutation = await fetch(`${ORIGIN}/state`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ value: "persisted" }),
  })
  if (stateMutation.status !== 200)
    throw new Error(`state mutation returned ${stateMutation.status}`)
  await stateMutation.arrayBuffer()

  const stateRead = await fetch(`${ORIGIN}/state?reconnect=1`, { headers: { connection: "close" } })
  const stateValue = (await stateRead.json()) as { value?: unknown }
  if (stateRead.status !== 200 || stateValue.value !== "persisted")
    throw new Error(`Durable Object state did not persist: ${JSON.stringify(stateValue)}`)

  const hostile = await fetch(`${ORIGIN}/lab/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "", count: 2 }),
  })
  if (hostile.status !== 422)
    throw new Error(`hostile contract input returned ${hostile.status}, expected 422`)
  await hostile.arrayBuffer()

  const first = await openWebSocket("/room")
  const second = await openWebSocket("/room")
  try {
    const firstMessage = nextMessage(first)
    const secondMessage = nextMessage(second)
    first.send("fanout")
    const received = await Promise.all([firstMessage, secondMessage])
    if (received[0] !== "fanout" || received[1] !== "fanout")
      throw new Error(`Durable Object WebSocket fan-out mismatch: ${received.join(", ")}`)
  } finally {
    first.close()
    second.close()
  }
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
  { cwd: ROOT, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
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
  await runContractLabOverHttp(ORIGIN)
  await runWorkersWitnesses()
  console.log("✓ workerd contract laboratory passed shared HTTP and Workers witnesses")
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(logs)
  process.exitCode = 1
} finally {
  killTree(child)
  await waitForExit(child).catch(() => undefined)
  rmSync(persist, { recursive: true, force: true })
}
