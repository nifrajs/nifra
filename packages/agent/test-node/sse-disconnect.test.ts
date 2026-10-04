/**
 * An agent run streamed over SSE, served by the Node adapter on Node itself: a client that hangs up
 * mid-run detaches. With an evidence log the run continues and its real result can be replayed;
 * without one, the disconnect aborts the run's signal.
 */

import assert from "node:assert/strict"
import { once } from "node:events"
import { type IncomingMessage, request } from "node:http"
import { test } from "node:test"
import type { AgentModelPort } from "@nifrajs/agent"
import { createMemoryAgentEvidenceLog } from "@nifrajs/agent/events"
import { mountAgent } from "@nifrajs/agent/mount"
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"
import { t } from "@nifrajs/schema"

const definition = {
  name: "reference-agent",
  instruction: "Return a concise answer.",
  input: t.object({ prompt: t.string() }),
  output: t.object({ answer: t.string() }),
  tools: [],
}

function post(port: number, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/agent",
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
      },
      resolve,
    )
    req.on("error", reject)
    req.end(JSON.stringify(body))
  })
}

async function text(res: IncomingMessage): Promise<string> {
  let out = ""
  for await (const chunk of res) out += String(chunk)
  return out
}

test("a hang-up mid-run leaves the run's real result replayable", async () => {
  const gate = Promise.withResolvers<void>()
  const model: AgentModelPort = {
    complete: async () => {
      await gate.promise
      return { kind: "output", value: { answer: "late" } }
    },
  }
  const app = server()
  mountAgent(app, {
    agent: definition,
    ports: () => ({ model, capabilities: [] }),
    evidenceLog: createMemoryAgentEvidenceLog(),
  })
  const handle = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const first = await post(handle.port, { input: { prompt: "hey" }, turnId: "run-gone" })
    await once(first, "data")
    first.destroy()
    await once(first, "close")
    gate.resolve()
    const replay = await post(
      handle.port,
      { input: { prompt: "hey" }, turnId: "run-gone" },
      { "last-event-id": "0" },
    )
    const body = await text(replay)
    assert.match(body, /event: result/)
    assert.match(body, /late/)
  } finally {
    await handle.stop()
  }
})

test("without an evidence log a hang-up aborts the run", async () => {
  const seen = Promise.withResolvers<AbortSignal>()
  const model: AgentModelPort = {
    complete: ({ signal }) => {
      seen.resolve(signal)
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    },
  }
  const app = server()
  mountAgent(app, { agent: definition, ports: () => ({ model, capabilities: [] }) })
  const handle = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const res = await post(handle.port, { input: { prompt: "hey" } })
    await once(res, "data")
    const signal = await seen.promise
    res.destroy()
    for (let attempt = 0; attempt < 100 && !signal.aborted; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(signal.aborted, true)
  } finally {
    await handle.stop()
  }
})
