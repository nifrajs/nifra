import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { AgentAppClient, AgentAppError } from "../src/client.ts"
import type { AgentTransport, AgentTransportRequest, CommandOutcome } from "../src/transport.ts"

const SNAPSHOT = {
  id: "session-1",
  backend: "test",
  status: "ready",
  createdAt: 1,
  updatedAt: 1,
  lastSeq: -1,
}

const ITEM = {
  kind: "handoff",
  requestId: "req-1",
  runId: "run-1",
  nodeId: "node-1",
  capability: "delegate",
  vector: 0,
  expiresAt: 5_000,
  state: "pending",
  // A leaked content field the client projection must never surface.
  prompt: "SECRET PROMPT",
}

/** A scriptable transport that records the last params it saw and returns canned command outcomes. */
class FakeTransport implements AgentTransport {
  lastParams: unknown
  constructor(private readonly capabilities: readonly string[]) {}

  async command<T>(request: AgentTransportRequest): Promise<CommandOutcome<T>> {
    this.lastParams = request.params
    const ok = (value: unknown): CommandOutcome<T> => ({ ok: true, status: 200, value: value as T })
    switch (request.method) {
      case "session.create":
        return ok({ ...SNAPSHOT, capabilities: this.capabilities })
      case "boundary.list":
        return ok({ items: [ITEM, { kind: "handoff", requestId: "broken" }] })
      case "boundary.inspect":
        return ok({ item: { ...ITEM, state: "assigned", to: "owner-a" } })
      case "boundary.resolve": {
        const coordinate = (request.params as { coordinate?: { vector?: number } }).coordinate
        if (coordinate?.vector !== 0) return ok({ rejected: "stale_vector" })
        return ok({ item: { ...ITEM, state: "resolved" } })
      }
      default:
        return { ok: false, status: 404, error: "not found" }
    }
  }

  stream(_request: AgentTransportRequest): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
      }),
    }
  }
}

async function connect(capabilities: readonly string[]): Promise<AgentAppClient> {
  const client = new AgentAppClient(new FakeTransport(capabilities))
  await client.createSession()
  return client
}

describe("agent-app inbox lifecycle", () => {
  test("negotiates the inbox feature from the host snapshot", async () => {
    const client = await connect(["inbox", "handoff"])
    expect(client.supports("inbox")).toBe(true)
  })

  test("lists boundaries as content-free views and drops malformed items", async () => {
    const client = await connect(["inbox"])
    const items = await client.listBoundaries()
    expect(items).toHaveLength(1)
    const [item] = items
    expect(item).toMatchObject({ requestId: "req-1", kind: "handoff", state: "pending" })
    expect(item).not.toHaveProperty("prompt")
  })

  test("decideBoundary sends the full coordinate identity and returns the resulting item", async () => {
    const transport = new FakeTransport(["inbox"])
    const client = new AgentAppClient(transport)
    await client.createSession()
    const coordinate = {
      runId: "run-1",
      nodeId: "node-1",
      capability: "delegate",
      requestId: "req-1",
      vector: 0,
      expiresAt: 5_000,
    }
    const result = await client.decideBoundary("resolve", coordinate)
    expect(transport.lastParams).toEqual({ coordinate })
    expect(result).toEqual({ ok: true, item: expect.objectContaining({ state: "resolved" }) })
  })

  test("surfaces a host rejection code for a stale coordinate", async () => {
    const client = await connect(["inbox"])
    const result = await client.decideBoundary("resolve", {
      runId: "run-1",
      nodeId: "node-1",
      capability: "delegate",
      requestId: "req-1",
      vector: 9,
      expiresAt: 5_000,
    })
    expect(result).toEqual({ ok: false, code: "stale_vector" })
  })

  test("refuses inbox commands when the host did not grant the feature", async () => {
    const client = await connect(["handoff"])
    expect(client.supports("inbox")).toBe(false)
    await expect(client.listBoundaries()).rejects.toBeInstanceOf(AgentAppError)
  })
})
