import { describe, expect, test } from "bun:test"
import { composeDescriptor } from "@nifrajs/agent/registry"
import {
  admitCapability,
  ChildVectorTracker,
  createStepCatalog,
  type HostPolicy,
  OrchestrationHost,
  OrchestrationStateError,
} from "../src/orchestration/index.ts"

const INPUT_SCHEMA = { type: "object", properties: { a: { type: "string" } } } as const

function descriptor(overrides: {
  readonly requiredCapabilities?: readonly string[]
  readonly isolation?: "inherit" | "process" | "sandbox"
  readonly approval?: { readonly kind: "none" } | { readonly kind: "required" }
  readonly kind?: "tool" | "extension"
}) {
  return composeDescriptor({
    kind: overrides.kind ?? "tool",
    name: "probe",
    inputSchema: INPUT_SCHEMA,
    requiredCapabilities: overrides.requiredCapabilities ?? ["filesystem"],
    ...(overrides.isolation === undefined ? {} : { isolation: overrides.isolation }),
    ...(overrides.approval === undefined ? {} : { approval: overrides.approval }),
  })
}

const STRICT: HostPolicy = {
  allowedKinds: ["tool", "mcp-tool"],
  allowedCapabilities: ["filesystem", "process"],
  minIsolation: "process",
  requireApproval: true,
}

describe("admitCapability", () => {
  test("admits a descriptor that meets every floor", async () => {
    const admission = admitCapability(
      STRICT,
      await descriptor({ isolation: "process", approval: { kind: "required" } }),
    )
    expect(admission.ok).toBe(true)
  })

  test("refuses a kind outside the allowlist", async () => {
    const admission = admitCapability(
      STRICT,
      await descriptor({ kind: "extension", isolation: "sandbox", approval: { kind: "required" } }),
    )
    expect(admission).toEqual({ ok: false, code: "kind_not_allowed" })
  })

  test("refuses a capability outside the allowlist", async () => {
    const admission = admitCapability(
      STRICT,
      await descriptor({
        requiredCapabilities: ["network"],
        isolation: "process",
        approval: { kind: "required" },
      }),
    )
    expect(admission).toEqual({ ok: false, code: "capability_not_allowed" })
  })

  test("refuses isolation weaker than the floor (descriptor cannot loosen policy)", async () => {
    const admission = admitCapability(
      STRICT,
      await descriptor({ isolation: "inherit", approval: { kind: "required" } }),
    )
    expect(admission).toEqual({ ok: false, code: "isolation_too_weak" })
  })

  test("refuses an approval downgrade to none", async () => {
    const admission = admitCapability(
      STRICT,
      await descriptor({ isolation: "sandbox", approval: { kind: "none" } }),
    )
    expect(admission).toEqual({ ok: false, code: "approval_downgrade" })
  })
})

describe("ChildVectorTracker", () => {
  test("allocates strictly increasing per-run vectors, isolated by run", () => {
    const tracker = new ChildVectorTracker()
    expect(tracker.last("run-a")).toBe(-1)
    expect(tracker.open("run-a")).toBe(0)
    expect(tracker.open("run-a")).toBe(1)
    expect(tracker.open("run-b")).toBe(0)
    expect(tracker.open("run-a")).toBe(2)
    expect(tracker.last("run-a")).toBe(2)
    tracker.release("run-a")
    expect(tracker.last("run-a")).toBe(-1)
  })
})

describe("OrchestrationHost policy admission", () => {
  const catalog = createStepCatalog({})

  test("passes through when no policy is configured", async () => {
    const host = new OrchestrationHost({ catalog })
    const any = await descriptor({})
    expect(() => host.admit(any)).not.toThrow()
  })

  test("refuses an inadmissible descriptor with E_POLICY_REJECTED", async () => {
    const host = new OrchestrationHost({ catalog, policy: STRICT })
    const bad = await descriptor({ isolation: "inherit", approval: { kind: "required" } })
    try {
      host.admit(bad)
      throw new Error("expected admission to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationStateError)
      expect((error as OrchestrationStateError).code).toBe("E_POLICY_REJECTED")
    }
  })

  test("openBoundaryVector rejects an unknown run", () => {
    const host = new OrchestrationHost({ catalog, policy: STRICT })
    try {
      host.openBoundaryVector("missing")
      throw new Error("expected E_NOT_FOUND")
    } catch (error) {
      expect((error as OrchestrationStateError).code).toBe("E_NOT_FOUND")
    }
  })
})
