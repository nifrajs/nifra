import { describe, expect, test } from "bun:test"
import type { AgentSessionSnapshot } from "@nifrajs/agent-protocol"
import { AgentAppClient, AgentAppError } from "../src/client.ts"
import type { AgentTransport, AgentTransportRequest, CommandOutcome } from "../src/transport.ts"

const snapshot = (capabilities: readonly string[]): AgentSessionSnapshot => ({
  version: 1,
  id: "compat-session",
  backend: "legacy",
  cwd: "/not-returned-by-view",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  lastSeq: 0,
  capabilities,
})

class CompatibilityTransport implements AgentTransport {
  readonly calls: AgentTransportRequest[] = []
  constructor(private readonly capabilities: readonly string[]) {}
  async command<T>(request: AgentTransportRequest): Promise<CommandOutcome<T>> {
    this.calls.push(request)
    if (request.method === "session.create")
      return { ok: true, status: 200, value: snapshot(this.capabilities) } as CommandOutcome<T>
    return { ok: false, status: 501, error: "feature_unsupported" }
  }
  async *stream(): AsyncIterable<never> {
    yield* [] as never[]
  }
}

describe("Agent App protocol compatibility", () => {
  test("new SDK with an old host grants the legacy intersection and blocks new commands locally", async () => {
    const transport = new CompatibilityTransport(["approvals", "resume"])
    const client = new AgentAppClient(transport)
    await client.createSession()
    expect(client.features).toEqual(["approvals", "resume"])
    expect(() => client.requireFeature("handoff")).toThrow(/did not grant.*handoff/)
    await expect(client.resolveHandoff({ runId: "r", nodeId: "n", accept: true })).rejects.toThrow(
      AgentAppError,
    )
    expect(transport.calls.some((call) => call.method === "handoff.resolve")).toBe(false)
  })

  test("old host response with additive capability fields remains a valid v1 session", async () => {
    const transport = new CompatibilityTransport(["approvals", "resume", "future-feature"])
    const client = new AgentAppClient(transport, { features: ["approvals", "future-feature"] })
    const view = await client.createSession()
    expect(view).not.toHaveProperty("cwd")
    expect(client.features).toEqual(["approvals", "future-feature"])
  })

  test("unsupported command responses retain the stable feature code", async () => {
    const transport = new CompatibilityTransport(["resume"])
    const client = new AgentAppClient(transport)
    await client.createSession()
    await expect(client.resume({ cursor: 0 })).rejects.toThrow(/feature_unsupported/)
  })
})
