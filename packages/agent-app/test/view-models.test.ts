import { describe, expect, test } from "bun:test"
import {
  type BoundaryStateView,
  boundaryCommands,
  boundaryIsStale,
  type RegistryCapabilityView,
  toRegistryCapabilityView,
} from "../src/view-models.ts"

const DIGEST = "a".repeat(64)

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    descriptorVersion: 1,
    kind: "tool",
    name: "search",
    version: "1.0.0",
    schemaDigest: DIGEST,
    requiredCapabilities: ["filesystem"],
    approval: { kind: "required" },
    retry: "none",
    idempotency: "request",
    isolation: "process",
    ...overrides,
  }
}

describe("toRegistryCapabilityView", () => {
  test("projects a descriptor to its content-free identity card", () => {
    const view = toRegistryCapabilityView(descriptor())
    expect(view).toEqual({
      kind: "tool",
      name: "search",
      version: "1.0.0",
      schemaDigest: DIGEST,
      requiredCapabilities: ["filesystem"],
      approval: "required",
      retry: "none",
      idempotency: "request",
      isolation: "process",
    } satisfies RegistryCapabilityView)
  })

  test("drops any content-bearing field on the raw record", () => {
    const view = toRegistryCapabilityView(
      descriptor({ inputSchema: { secret: true }, description: "leak", prompt: "leak" }),
    )
    expect(view).not.toBeUndefined()
    expect(view).not.toHaveProperty("inputSchema")
    expect(view).not.toHaveProperty("description")
    expect(view).not.toHaveProperty("prompt")
  })

  test("carries a numeric threshold level as a bound, not content", () => {
    const view = toRegistryCapabilityView(descriptor({ approval: { kind: "threshold", level: 2 } }))
    expect(view?.approval).toBe("threshold")
    expect(view?.approvalLevel).toBe(2)
  })

  test.each([
    ["unknown kind", { kind: "provider" }],
    ["missing name", { name: "" }],
    ["short digest", { schemaDigest: "abc" }],
    ["non-string capability", { requiredCapabilities: [1] }],
    ["bad isolation", { isolation: "vm" }],
    ["malformed approval", { approval: { kind: "maybe" } }],
    ["not a record", undefined],
  ])("returns undefined for %s", (_label, overrides) => {
    const raw = overrides === undefined ? "nope" : descriptor(overrides as Record<string, unknown>)
    expect(toRegistryCapabilityView(raw)).toBeUndefined()
  })
})

describe("boundaryCommands", () => {
  const at = (
    kind: "approval" | "handoff",
    state: string,
    expiresAt = 10_000,
  ): BoundaryStateView => ({
    kind,
    state,
    expiresAt,
  })

  test("offers approve, deny, and cancel on a pending approval", () => {
    expect(boundaryCommands(at("approval", "pending"), { inbox: true, now: 0 })).toEqual([
      "approve",
      "deny",
      "cancel",
    ])
  })

  test("offers assign and cancel on a pending handoff, resolve only once assigned", () => {
    expect(boundaryCommands(at("handoff", "pending"), { inbox: true, now: 0 })).toEqual([
      "assign",
      "cancel",
    ])
    expect(boundaryCommands(at("handoff", "assigned"), { inbox: true, now: 0 })).toEqual([
      "resolve",
      "cancel",
    ])
  })

  test.each([
    "approved",
    "denied",
    "expired",
    "cancelled",
  ])("offers nothing on the terminal approval state %s", (state) => {
    expect(boundaryCommands(at("approval", state), { inbox: true, now: 0 })).toEqual([])
  })

  test.each([
    "resolved",
    "declined",
    "expired",
    "cancelled",
  ])("offers nothing on the terminal handoff state %s", (state) => {
    expect(boundaryCommands(at("handoff", state), { inbox: true, now: 0 })).toEqual([])
  })

  test("offers resolve and cancel on an accepted handoff", () => {
    expect(boundaryCommands(at("handoff", "accepted"), { inbox: true, now: 0 })).toEqual([
      "resolve",
      "cancel",
    ])
  })

  test("offers nothing for an unsupported state", () => {
    expect(boundaryCommands(at("approval", "reticulating"), { inbox: true, now: 0 })).toEqual([])
  })

  test("fails closed when the inbox feature is not negotiated", () => {
    expect(boundaryCommands(at("approval", "pending"), { inbox: false, now: 0 })).toEqual([])
  })

  test("fails closed at or past expiry", () => {
    const item = at("approval", "pending", 5_000)
    expect(boundaryIsStale(item, 4_999)).toBe(false)
    expect(boundaryIsStale(item, 5_000)).toBe(true)
    expect(boundaryCommands(item, { inbox: true, now: 5_000 })).toEqual([])
  })
})
