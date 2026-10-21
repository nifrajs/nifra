#!/usr/bin/env bun
/** Run the Workers adapter's contract witnesses against a real local workerd process. */
import { join, resolve } from "node:path"
import { rawUpgradeStatus } from "../packages/core/test/request-target-matrix.ts"
import {
  certifyAdapter,
  defineCertificationProfile,
} from "../packages/testing/src/certification.ts"
import {
  createReferenceContractLabHandler,
  runContractLabOverHttp,
} from "../packages/testing/src/contract-lab.ts"
import { startWranglerDev } from "./wrangler-dev.ts"

const ROOT = resolve(import.meta.dir, "..")
const CONFIG = join(ROOT, "packages/workers/test/workerd/wrangler.toml")

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
  capabilities: [
    "contract-lab",
    "durable-object-state",
    "websocket-broadcast",
    "websocket-hub-http-pass",
  ],
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
    {
      // An upgrade request for a plain HTTP route gets that route's answer, as on every other runtime,
      // although the hub Durable Object is what resolves it.
      id: "websocket-hub-http-pass",
      capability: "websocket-hub-http-pass",
      target: { witnessKind: "websocket" },
      async run(adapter) {
        const status = await rawUpgradeStatus(Number(new URL(adapter.origin).port), "/lab/created")
        if (status !== 201) throw new Error(`WebSocketHubHttpPass${status}`)
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

const dev = await startWranglerDev(CONFIG)
try {
  await runBunContractLab()
  await dev.ready("/__nifra_ready__")
  const report = await certifyAdapter({
    profile: workerdCertificationProfile,
    adapterId: "workers-workerd",
    target: {
      adapter: "@nifrajs/workers",
      runtime: "workerd",
      artifact: "packages/workers/test/workerd/worker.ts",
      source: "packages/workers/src/index.ts",
    },
    createAdapter: () => ({ origin: dev.origin }),
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
  console.error(dev.logs())
  process.exitCode = 1
} finally {
  await dev.stop()
}
