import { describe, expect, test } from "bun:test"
import {
  CompileError,
  compileRunPlan,
  createStepCatalog,
  deriveNodeEffectKey,
  digestRunPlan,
  EVIDENCE_MAX_BYTES,
  FORBIDDEN_CONTENT_KEYS,
  memoryArtifactPort,
  noopArtifactPort,
  parseRunEvidence,
  parseRunPlan,
  RunContractError,
  type RunEvidence,
  type RunPlan,
  runTrace,
  type StepCatalog,
} from "../src/orchestration/index.ts"

const encoder = new TextEncoder()

/** A catalog exercising every kind, an idempotent step, and an artifact-emitting step. */
function fixtureCatalog(): StepCatalog {
  return createStepCatalog({
    "charge.card": {
      kind: "task",
      // identity is the (content-free projection of the) amount + currency, never the PAN
      selectEffect: (ctx) => encoder.encode(`${ctx.nodeId}:usd:4200`),
      run: async (ctx) => {
        // A raw payload leaves transient execution ONLY through the caller-owned port.
        await ctx.artifact.put(new Uint8Array(64_000).fill(7), {
          planDigest: ctx.planDigest,
          nodeId: ctx.nodeId,
          kind: "tool_output",
        })
        ctx.set(ctx.nodeId, "done")
      },
    },
    "plan.step": {
      kind: "task",
      run: (ctx) => ctx.set(ctx.nodeId, "planned"),
    },
    "verify.ok": {
      kind: "verify",
      run: () => true,
    },
    "verify.fail": {
      kind: "verify",
      run: () => false,
    },
    "approve.gate": {
      kind: "approve",
      run: () => true,
    },
  })
}

const onePlan: RunPlan = {
  version: 1,
  id: "plan-one",
  nodes: [{ id: "a", kind: "task", step: "charge.card" }],
}

describe("run plan contract", () => {
  test("parses a valid single-node plan", () => {
    expect(parseRunPlan(onePlan).nodes).toHaveLength(1)
  })

  test("rejects an unknown key (closure smuggling)", () => {
    expect(() => parseRunPlan({ ...onePlan, run: () => 1 })).toThrow(RunContractError)
  })

  test("rejects a content-bearing key on a node (strict allow-list)", () => {
    const bad = { version: 1, id: "p", nodes: [{ id: "a", kind: "task", step: "s", prompt: "hi" }] }
    expect(() => parseRunPlan(bad)).toThrow(/unknown key 'prompt'/)
  })

  test("rejects a duplicate node id", () => {
    const dup = {
      version: 1,
      id: "p",
      nodes: [
        { id: "a", kind: "task", step: "s" },
        { id: "a", kind: "task", step: "s" },
      ],
    }
    expect(() => parseRunPlan(dup)).toThrow(/duplicate node id/)
  })

  test("rejects a dependency on an unknown node", () => {
    const bad = {
      version: 1,
      id: "p",
      nodes: [{ id: "a", kind: "task", step: "s", dependsOn: ["z"] }],
    }
    expect(() => parseRunPlan(bad)).toThrow(/unknown/)
  })

  test("requires a reason on an approve node", () => {
    const bad = { version: 1, id: "p", nodes: [{ id: "a", kind: "approve", step: "s" }] }
    expect(() => parseRunPlan(bad)).toThrow(/requires a reason/)
  })
})

describe("evidence is content-free", () => {
  const base: RunEvidence = {
    version: 1,
    runId: "r",
    planDigest: "a".repeat(64),
    nodeId: "a",
    status: "completed",
    seq: 0,
    idempotent: false,
  }

  test("accepts a minimal record", () => {
    expect(parseRunEvidence(base).nodeId).toBe("a")
  })

  test("rejects any forbidden content key", () => {
    for (const key of FORBIDDEN_CONTENT_KEYS) {
      expect(() => parseRunEvidence({ ...base, [key]: "leaked" })).toThrow(RunContractError)
    }
  })

  test("rejects an unknown key", () => {
    expect(() => parseRunEvidence({ ...base, secret: 1 })).toThrow(/unknown key/)
  })

  test("rejects a record over the size cap", () => {
    const oversize = { ...base, errorCode: "x".repeat(EVIDENCE_MAX_BYTES) }
    expect(() => parseRunEvidence(oversize)).toThrow(/exceeds/)
  })
})

describe("node effect key", () => {
  test("is a 64-char hex digest", async () => {
    const key = await deriveNodeEffectKey({
      planDigest: "p",
      nodeId: "a",
      selector: encoder.encode("x"),
    })
    expect(key.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  test("same identity converges, different identity diverges", async () => {
    const a1 = await deriveNodeEffectKey({
      planDigest: "p",
      nodeId: "a",
      selector: encoder.encode("42"),
    })
    const a2 = await deriveNodeEffectKey({
      planDigest: "p",
      nodeId: "a",
      selector: encoder.encode("42"),
    })
    const b = await deriveNodeEffectKey({
      planDigest: "p",
      nodeId: "a",
      selector: encoder.encode("43"),
    })
    expect(a1.digest).toBe(a2.digest)
    expect(a1.digest).not.toBe(b.digest)
  })
})

describe("artifact port", () => {
  test("noop yields a content-free ref and never returns the payload", async () => {
    const port = noopArtifactPort()
    const payload = encoder.encode("super-secret-model-output")
    const ref = await port.put(payload, { planDigest: "p", nodeId: "a", kind: "model_output" })
    expect(ref.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(ref.bytes).toBe(payload.length)
    // the ref carries no field holding the bytes
    expect(JSON.stringify(ref)).not.toContain("super-secret")
  })

  test("memory port retains bytes for tests and refuses a large budget", async () => {
    const port = memoryArtifactPort({ maxBytes: 32 })
    const ref = await port.put(encoder.encode("hi"), { planDigest: "p", nodeId: "a", kind: "x" })
    expect(port.get(ref.id)).toEqual(encoder.encode("hi"))
    await expect(
      port.put(new Uint8Array(64), { planDigest: "p", nodeId: "a", kind: "x" }),
    ).rejects.toThrow(/test-only/)
  })
})

describe("compile", () => {
  test("rejects an unknown step", () => {
    const plan: RunPlan = { version: 1, id: "p", nodes: [{ id: "a", kind: "task", step: "nope" }] }
    expect(() => compileRunPlan(plan, mkOpts())).toThrow(CompileError)
  })

  test("rejects a kind mismatch", () => {
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [{ id: "a", kind: "verify", step: "plan.step" }],
    }
    expect(() => compileRunPlan(plan, mkOpts())).toThrow(/does not match/)
  })

  test("rejects a multi-node cycle", () => {
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [
        { id: "a", kind: "task", step: "plan.step", dependsOn: ["b"] },
        { id: "b", kind: "task", step: "plan.step", dependsOn: ["a"] },
      ],
    }
    expect(() => compileRunPlan(plan, mkOpts())).toThrow(/cycle/)
  })

  function mkOpts() {
    return {
      catalog: fixtureCatalog(),
      planDigest: "p".repeat(64),
      artifactPort: noopArtifactPort(),
    }
  }
})

describe("end-to-end tracer", () => {
  test("runs, is deterministic, and attaches an effect key + artifact ref", async () => {
    const opts = { runId: "run-1", catalog: fixtureCatalog() }
    const first = await runTrace(onePlan, opts)
    const second = await runTrace(onePlan, opts)

    expect(first.ok).toBe(true)
    expect(first.terminalDigest).toBe(second.terminalDigest)
    expect(first.planDigest).toBe(second.planDigest)
    expect(first.planDigest).toBe(await digestRunPlan(parseRunPlan(onePlan)))

    const completed = first.evidence.find((e) => e.status === "completed")
    expect(completed?.effectKey).toMatch(/^[0-9a-f]{64}$/)
    expect(completed?.idempotent).toBe(true)
    expect(completed?.artifacts?.[0]?.bytes).toBe(64_000)
    expect(completed?.artifacts?.[0]?.digest).toMatch(/^[0-9a-f]{64}$/)

    // every emitted record survives the strict content-free parser
    for (const record of first.evidence) {
      expect(() => parseRunEvidence(record)).not.toThrow()
      expect(new TextEncoder().encode(JSON.stringify(record)).length).toBeLessThanOrEqual(
        EVIDENCE_MAX_BYTES,
      )
    }
  })

  test("orders a DAG deterministically by dependency then id", async () => {
    const plan: RunPlan = {
      version: 1,
      id: "dag",
      nodes: [
        { id: "c", kind: "verify", step: "verify.ok", dependsOn: ["a", "b"] },
        { id: "b", kind: "task", step: "plan.step" },
        { id: "a", kind: "task", step: "plan.step" },
      ],
    }
    const trace = await runTrace(plan, { runId: "r", catalog: fixtureCatalog() })
    const startedOrder = trace.evidence.filter((e) => e.status === "started").map((e) => e.nodeId)
    expect(startedOrder).toEqual(["a", "b", "c"])
    expect(trace.ok).toBe(true)
  })

  test("a failed verify yields ok=false with a failed record after prior completions", async () => {
    const plan: RunPlan = {
      version: 1,
      id: "fail",
      nodes: [
        { id: "a", kind: "task", step: "plan.step" },
        { id: "b", kind: "verify", step: "verify.fail", dependsOn: ["a"] },
      ],
    }
    const trace = await runTrace(plan, { runId: "r", catalog: fixtureCatalog() })
    expect(trace.ok).toBe(false)
    expect(trace.evidence.some((e) => e.nodeId === "a" && e.status === "completed")).toBe(true)
    const failed = trace.evidence.find((e) => e.status === "failed")
    expect(failed?.nodeId).toBe("b")
    expect(failed?.errorCode).toBe("GATE_REJECTED")
    // the rejected gate is never also reported completed
    expect(trace.evidence.some((e) => e.nodeId === "b" && e.status === "completed")).toBe(false)
  })

  test("a thrown task step yields a STEP_FAILED record", async () => {
    const catalog = createStepCatalog({
      boom: {
        kind: "task",
        run: () => {
          throw new Error("kaboom")
        },
      },
    })
    const plan: RunPlan = {
      version: 1,
      id: "boom",
      nodes: [{ id: "a", kind: "task", step: "boom" }],
    }
    const trace = await runTrace(plan, { runId: "r", catalog })
    expect(trace.ok).toBe(false)
    const failed = trace.evidence.find((e) => e.status === "failed")
    expect(failed?.nodeId).toBe("a")
    expect(failed?.errorCode).toBe("STEP_FAILED")
  })
})
