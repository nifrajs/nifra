/**
 * Replay fixtures for the Workbench decision inbox (UX-05). The Workbench inbox is driven only by the
 * SDK: `AgentAppClient.listBoundaries` / `decideBoundary` for transport, and `boundaryCommands` for
 * which controls a live boundary may present. These tests exercise that exact path against a scripted
 * transport, so they cover the same logic the browser bundle runs without needing a DOM.
 */

import { describe, expect, test } from "bun:test"
import {
  AgentAppClient,
  type AgentTransport,
  type AgentTransportRequest,
  type BoundaryItemView,
  boundaryCommands,
  type CommandOutcome,
} from "@nifrajs/agent-app"

const FUTURE = 1_000_000

function boundary(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "approval",
    requestId: "req-1",
    runId: "run-1",
    nodeId: "node-1",
    capability: "filesystem",
    vector: 0,
    expiresAt: FUTURE,
    state: "pending",
    ...overrides,
  }
}

/** A boundary set spanning every lifecycle state the inbox must fixture, plus junk to be dropped. */
const ITEMS: Record<string, unknown>[] = [
  boundary({ requestId: "a-pending", kind: "approval", state: "pending" }),
  boundary({ requestId: "a-approved", kind: "approval", state: "approved" }),
  boundary({ requestId: "a-denied", kind: "approval", state: "denied" }),
  boundary({ requestId: "a-cancelled", kind: "approval", state: "cancelled" }),
  boundary({ requestId: "h-pending", kind: "handoff", state: "pending" }),
  boundary({ requestId: "h-assigned", kind: "handoff", state: "assigned", to: "owner-a" }),
  boundary({ requestId: "h-resolved", kind: "handoff", state: "resolved" }),
  boundary({ requestId: "h-expired", kind: "handoff", state: "expired" }),
  boundary({ requestId: "unsupported", kind: "approval", state: "reticulating" }),
  // A stale but still-pending boundary: past its expiry, so it must offer no command.
  boundary({ requestId: "stale", kind: "approval", state: "pending", expiresAt: 10 }),
  // A boundary carrying a leaked content field the projection must strip.
  boundary({ requestId: "leaky", prompt: "SECRET", reason: "because" }),
  // Malformed: no coordinate. Must be dropped from the list entirely.
  { kind: "handoff", requestId: "broken" },
]

class FakeTransport implements AgentTransport {
  lastParams: unknown
  constructor(private readonly capabilities: readonly string[]) {}

  async command<T>(request: AgentTransportRequest): Promise<CommandOutcome<T>> {
    this.lastParams = request.params
    const ok = (value: unknown): CommandOutcome<T> => ({ ok: true, status: 200, value: value as T })
    switch (request.method) {
      case "session.create":
        return ok({
          id: "s1",
          backend: "replay",
          status: "ready",
          createdAt: 1,
          updatedAt: 1,
          lastSeq: -1,
          capabilities: this.capabilities,
        })
      case "boundary.list":
        return ok({ items: ITEMS })
      case "boundary.resolve":
      case "boundary.approve":
      case "boundary.cancel": {
        const coordinate = (request.params as { coordinate?: { vector?: number } }).coordinate
        if (coordinate?.vector !== 0) return ok({ rejected: "stale_vector" })
        return ok({ item: boundary({ state: "resolved" }) })
      }
      default:
        return { ok: false, status: 404, error: "not found" }
    }
  }

  stream(_request: AgentTransportRequest): AsyncIterable<never> {
    return {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    }
  }
}

async function connect(capabilities: readonly string[]): Promise<[AgentAppClient, FakeTransport]> {
  const transport = new FakeTransport(capabilities)
  const client = new AgentAppClient(transport)
  await client.createSession()
  return [client, transport]
}

function byId(items: readonly BoundaryItemView[], requestId: string): BoundaryItemView {
  const item = items.find((entry) => entry.requestId === requestId)
  if (item === undefined) throw new Error(`missing fixture ${requestId}`)
  return item
}

describe("workbench decision inbox", () => {
  test("lists boundaries content-free, dropping malformed items and stripping content fields", async () => {
    const [client] = await connect(["inbox"])
    const items = await client.listBoundaries()
    expect(items.find((entry) => entry.requestId === "broken")).toBeUndefined()
    const leaky = byId(items, "leaky")
    expect(leaky).not.toHaveProperty("prompt")
    expect(leaky).not.toHaveProperty("reason")
  })

  test("offers commands only for live, fresh states and none for terminal, stale, or unsupported", async () => {
    const [client] = await connect(["inbox"])
    const items = await client.listBoundaries()
    const now = 1_000
    const cmds = (id: string) => [...boundaryCommands(byId(items, id), { inbox: true, now })]
    expect(cmds("a-pending")).toEqual(["approve", "deny", "cancel"])
    expect(cmds("h-pending")).toEqual(["assign", "cancel"])
    expect(cmds("h-assigned")).toEqual(["resolve", "cancel"])
    for (const terminal of ["a-approved", "a-denied", "a-cancelled", "h-resolved", "h-expired"])
      expect(cmds(terminal)).toEqual([])
    expect(cmds("unsupported")).toEqual([])
    expect(cmds("stale")).toEqual([]) // past expiry: fails closed even though state is pending
  })

  test("a decision carries the exact boundary coordinate and cannot address another item", async () => {
    const [client, transport] = await connect(["inbox"])
    const items = await client.listBoundaries()
    const item = byId(items, "a-pending")
    const result = await client.decideBoundary("approve", {
      runId: item.runId,
      nodeId: item.nodeId,
      capability: item.capability,
      requestId: item.requestId,
      vector: item.vector,
      expiresAt: item.expiresAt,
    })
    expect(transport.lastParams).toEqual({
      coordinate: {
        runId: "run-1",
        nodeId: "node-1",
        capability: "filesystem",
        requestId: "a-pending",
        vector: 0,
        expiresAt: FUTURE,
      },
    })
    expect(result).toEqual({ ok: true, item: expect.objectContaining({ state: "resolved" }) })
  })

  test("surfaces the host refusal code for a superseded coordinate", async () => {
    const [client] = await connect(["inbox"])
    const result = await client.decideBoundary("resolve", {
      runId: "run-1",
      nodeId: "node-1",
      capability: "filesystem",
      requestId: "h-assigned",
      vector: 7,
      expiresAt: FUTURE,
    })
    expect(result).toEqual({ ok: false, code: "stale_vector" })
  })

  test("stays usable when the host does not offer the inbox feature", async () => {
    const [client] = await connect(["approvals"])
    expect(client.supports("inbox")).toBe(false)
    // The inbox gates on the negotiated feature and offers no command rather than throwing at render.
    expect(
      boundaryCommands(
        { kind: "approval", state: "pending", expiresAt: FUTURE },
        {
          inbox: client.supports("inbox"),
          now: 0,
        },
      ),
    ).toEqual([])
  })
})
