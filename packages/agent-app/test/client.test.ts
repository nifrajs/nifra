import { describe, expect, test } from "bun:test"
import type { AgentEvent, AgentSessionSnapshot } from "@nifrajs/agent-protocol"
import { AgentAppClient, AgentAppError } from "../src/client.ts"
import type { AgentTransport, AgentTransportRequest, CommandOutcome } from "../src/transport.ts"
import { OrderedEventBuffer, toEventView } from "../src/view-models.ts"

const snapshot = (overrides: Partial<AgentSessionSnapshot> = {}): AgentSessionSnapshot => ({
  version: 1,
  id: "session-1",
  backend: "fake",
  cwd: "/secret/path",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  lastSeq: 0,
  capabilities: ["approvals", "resume", "workflows"],
  ...overrides,
})

const delta = (seq: number, text: string): AgentEvent => ({
  version: 1,
  sessionId: "session-1",
  seq,
  at: seq,
  type: "assistant.delta",
  turnId: "turn-1",
  text,
})

class FakeTransport implements AgentTransport {
  readonly calls: AgentTransportRequest[] = []
  constructor(
    private readonly onCommand: (request: AgentTransportRequest) => CommandOutcome<unknown>,
    private readonly events: readonly AgentEvent[] = [],
  ) {}
  async command<T>(request: AgentTransportRequest): Promise<CommandOutcome<T>> {
    this.calls.push(request)
    return this.onCommand(request) as CommandOutcome<T>
  }
  async *stream(request: AgentTransportRequest): AsyncIterable<AgentEvent> {
    this.calls.push(request)
    for (const event of this.events) yield event
  }
}

describe("AgentAppClient session + negotiation", () => {
  test("createSession negotiates the granted feature set and hides the cwd", async () => {
    const transport = new FakeTransport(() => ({ ok: true, status: 200, value: snapshot() }))
    const client = new AgentAppClient(transport)
    const view = await client.createSession({ cwd: "/secret/path" })
    expect(view.id).toBe("session-1")
    expect(view).not.toHaveProperty("cwd")
    // requested ∩ advertised, sorted.
    expect(client.features).toEqual(["approvals", "resume", "workflows"])
    expect(client.supports("workflows")).toBe(true)
    expect(client.supports("fork")).toBe(false)
  })

  test("requireFeature throws for an ungranted feature", async () => {
    const transport = new FakeTransport(() => ({
      ok: true,
      status: 200,
      value: snapshot({ capabilities: [] }),
    }))
    const client = new AgentAppClient(transport)
    await client.createSession()
    expect(() => client.requireFeature("resume")).toThrow(AgentAppError)
  })

  test("a session command error surfaces as AgentAppError, never a raw throw of the credential", async () => {
    const transport = new FakeTransport(() => ({ ok: false, status: 401, error: "unauthorized" }))
    const client = new AgentAppClient(transport)
    await expect(client.createSession()).rejects.toThrow(/session.create failed \(401\)/)
  })
})

describe("AgentAppClient.send", () => {
  test("orders and deduplicates the live stream into content-free views", async () => {
    const events = [delta(1, "he"), delta(3, "lo"), delta(2, "l"), delta(2, "dup"), delta(4, "!")]
    const transport = new FakeTransport(
      () => ({ ok: true, status: 200, value: snapshot() }),
      events,
    )
    const client = new AgentAppClient(transport)
    await client.createSession()
    const seen: Array<{ seq: number; chars: number }> = []
    for await (const view of client.send("hi")) {
      expect(view).not.toHaveProperty("text")
      if (view.kind === "assistant.delta") seen.push({ seq: view.seq, chars: view.chars })
    }
    expect(seen.map((v) => v.seq)).toEqual([1, 2, 3, 4])
    // chars come from the first delivery of each seq; the duplicate seq 2 ("dup") is dropped.
    expect(seen.find((v) => v.seq === 2)?.chars).toBe(1)
    expect(transport.calls.at(-1)?.method).toBe("turn.send")
  })

  test("send before createSession is rejected", async () => {
    const transport = new FakeTransport(() => ({ ok: true, status: 200, value: snapshot() }))
    const client = new AgentAppClient(transport)
    const drain = (async () => {
      for await (const _ of client.send("hi")) void _
    })()
    await expect(drain).rejects.toThrow(AgentAppError)
  })
})

describe("AgentAppClient.resume", () => {
  const withResume = (value: unknown) =>
    new AgentAppClient(
      new FakeTransport((request) =>
        request.method === "session.create"
          ? { ok: true, status: 200, value: snapshot() }
          : { ok: true, status: 200, value },
      ),
    )

  test("projects a persisted window to ordering + type only, dropping payloads", async () => {
    const client = withResume({
      snapshot: snapshot(),
      resume: {
        status: "ok",
        nextCursor: 5,
        events: [
          { seq: 4, at: 40, type: "session.checkpoint", payload: { secret: "x" } },
          { seq: 5, at: 50, type: "turn.started", payload: { prompt: "leak" } },
        ],
      },
    })
    await client.createSession()
    const result = await client.resume({ cursor: 3, limit: 10 })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.nextCursor).toBe(5)
    expect(result.entries).toEqual([
      { seq: 4, at: 40, type: "session.checkpoint" },
      { seq: 5, at: 50, type: "turn.started" },
    ])
    for (const entry of result.entries) expect(entry).not.toHaveProperty("payload")
  })

  test("surfaces a resync request from a stale cursor", async () => {
    const client = withResume({
      resume: { status: "resync_required", reason: "stale_cursor", earliest: 8, latest: 12 },
    })
    await client.createSession()
    const result = await client.resume({ cursor: 0 })
    expect(result).toEqual({
      status: "resync_required",
      reason: "stale_cursor",
      earliest: 8,
      latest: 12,
    })
  })

  test("resume requires the granted feature", async () => {
    const client = new AgentAppClient(
      new FakeTransport(() => ({
        ok: true,
        status: 200,
        value: snapshot({ capabilities: [] }),
      })),
    )
    await client.createSession()
    await expect(client.resume()).rejects.toThrow(/did not grant the "resume"/)
  })
})

describe("AgentAppClient approvals", () => {
  test("lists pending approvals as identifiers and records a decision", async () => {
    const transport = new FakeTransport((request) => {
      switch (request.method) {
        case "session.create":
          return { ok: true, status: 200, value: snapshot() }
        case "approval.list":
          return {
            ok: true,
            status: 200,
            value: {
              pending: [
                { approvalId: "a1", action: "write file", capability: "filesystem", extra: "x" },
              ],
            },
          }
        case "approval.resolve":
          return { ok: true, status: 200, value: { approved: true } }
        default:
          return { ok: false, status: 404, error: "unknown" }
      }
    })
    const client = new AgentAppClient(transport)
    await client.createSession()
    const pending = await client.listApprovals()
    expect(pending).toEqual([{ approvalId: "a1", action: "write file", capability: "filesystem" }])
    expect(await client.resolveApproval("a1", true)).toBe(true)
    const resolveCall = transport.calls.find((c) => c.method === "approval.resolve")
    expect(resolveCall?.params).toEqual({ approvalId: "a1", approved: true })
  })
})

describe("OrderedEventBuffer gap recovery", () => {
  test("skips an unfilled gap once maxPending is exceeded and counts the drop", () => {
    const buffer = new OrderedEventBuffer({ from: 0, maxPending: 2 })
    const view = (seq: number) => toEventView(delta(seq, "x"))
    expect(buffer.offer(view(1)).map((v) => v.seq)).toEqual([1])
    // seq 2 missing; hold 3,4 -> still within maxPending, nothing emitted.
    expect(buffer.offer(view(3))).toEqual([])
    expect(buffer.offer(view(4))).toEqual([])
    // a third pending exceeds maxPending: skip to the lowest held seq (3), emit 3,4.
    expect(buffer.offer(view(6)).map((v) => v.seq)).toEqual([3, 4])
    expect(buffer.dropped).toBeGreaterThan(0)
    expect(buffer.offer(view(6))).toEqual([]) // duplicate of an already-buffered seq
  })
})
