/**
 * End-to-end smoke over the shipped SDK: a real RPC server fronting a ReplayBackend, driven by the
 * same `@nifrajs/agent-app` client the browser bundle uses. Proves the transport, negotiation, and
 * content-free event stream hold across the HTTP boundary - and that nothing content-bearing leaks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { AgentAppClient, type AgentEventView, HttpAgentTransport } from "@nifrajs/agent-app"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { CodingAgentRpcServer, ReplayBackend } from "@nifrajs/coding-agent"

const sessionId = "smoke-session"
const turnId = "turn-1"
const base = { version: 1, sessionId } as const
const events: readonly AgentEvent[] = [
  { ...base, seq: 1, at: 1, type: "turn.started", turnId, prompt: "inspect the project" },
  { ...base, seq: 2, at: 2, type: "assistant.delta", turnId, text: "secret model text" },
  {
    ...base,
    seq: 3,
    at: 3,
    type: "tool.started",
    turnId,
    callId: "c1",
    name: "read_file",
    input: { path: "/etc/passwd" },
  },
  {
    ...base,
    seq: 4,
    at: 4,
    type: "tool.completed",
    turnId,
    callId: "c1",
    name: "read_file",
    ok: true,
  },
  { ...base, seq: 5, at: 5, type: "assistant.message", turnId, text: "final private answer" },
]

let server: CodingAgentRpcServer
let url: string
let token: string

beforeAll(async () => {
  server = new CodingAgentRpcServer({
    backend: new ReplayBackend({ events }),
    cwd: process.cwd(),
    hostname: "127.0.0.1",
  })
  const handle = await server.start()
  url = handle.url
  token = handle.token
})

afterAll(async () => {
  await server.stop()
})

describe("workbench SDK smoke", () => {
  test("drives a replay session over HTTP and yields only content-free views", async () => {
    const transport = new HttpAgentTransport({ endpoint: url, authorize: () => token })
    const client = new AgentAppClient(transport)
    const session = await client.createSession({ sessionId })
    expect(session.id).toBe(sessionId)
    expect(session).not.toHaveProperty("cwd")

    const views: AgentEventView[] = []
    for await (const view of client.send("inspect the project")) views.push(view)

    const seqs = views.map((v) => v.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(seqs).toContain(2)
    expect(seqs).toContain(5)

    // No projected view carries prompt text, tool input, or model output.
    const serialized = JSON.stringify(views)
    expect(serialized).not.toContain("secret model text")
    expect(serialized).not.toContain("final private answer")
    expect(serialized).not.toContain("/etc/passwd")

    const delta = views.find((v) => v.kind === "assistant.delta")
    expect(delta && "chars" in delta ? delta.chars : 0).toBe("secret model text".length)
    const tool = views.find((v) => v.kind === "tool.started")
    expect(tool && "name" in tool ? tool.name : "").toBe("read_file")
    expect(tool).not.toHaveProperty("input")
  })
})
