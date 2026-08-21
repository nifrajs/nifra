import { describe, expect, test } from "bun:test"
import {
  type CompileError,
  compileRunPlan,
  createStepCatalog,
  mergeStepCatalogs,
  noopArtifactPort,
  parseRunPlan,
  RunContractError,
  type RunPlan,
  type StepCatalog,
} from "../src/orchestration/index.ts"
import { WorkflowRunner, type WorkflowStep } from "../src/workflows.ts"

const PLAN_DIGEST = "p".repeat(64)

function compile(plan: RunPlan | unknown, catalog: StepCatalog, limits?: object): WorkflowStep {
  return compileRunPlan(plan, {
    catalog,
    planDigest: PLAN_DIGEST,
    artifactPort: noopArtifactPort(),
    ...(limits !== undefined ? { limits } : {}),
  })
}

function run(step: WorkflowStep) {
  return new WorkflowRunner({ maxSteps: 4096, maxDepth: 32 }).run(step)
}

describe("leaf-kind parity with direct WorkflowStep", () => {
  const cases: ReadonlyArray<{
    readonly kind: "task" | "verify" | "approve" | "checkpoint" | "handoff"
    readonly reason?: string
  }> = [
    { kind: "task" },
    { kind: "verify" },
    { kind: "approve", reason: "ship it" },
    { kind: "checkpoint" },
    { kind: "handoff" },
  ]

  for (const { kind, reason } of cases) {
    test(`${kind} node matches a hand-built ${kind} step`, async () => {
      const body = (set: (n: string, v: unknown) => void): true => {
        set("touched", kind)
        return true
      }
      const catalog = createStepCatalog({
        s: { kind, run: (ctx) => body((n, v) => ctx.set(n, v)) },
      })
      const node = { id: "a", kind, step: "s", ...(reason !== undefined ? { reason } : {}) }
      const plan: RunPlan = { version: 1, id: "p", nodes: [node] }

      const direct: WorkflowStep =
        kind === "approve"
          ? {
              type: "approve",
              id: "a",
              reason: reason ?? "",
              run: (wf) => body((n, v) => wf.set(n, v)),
            }
          : kind === "verify"
            ? { type: "verify", id: "a", run: (wf) => body((n, v) => wf.set(n, v)) }
            : kind === "checkpoint"
              ? { type: "checkpoint", id: "a", run: (wf) => body((n, v) => wf.set(n, v)) }
              : kind === "handoff"
                ? { type: "handoff", id: "a", run: (wf) => body((n, v) => wf.set(n, v)) }
                : { type: "task", id: "a", run: (wf) => body((n, v) => wf.set(n, v)) }

      const compiled = await run(compile(plan, catalog))
      const reference = await run(direct)
      expect(compiled.ok).toBe(reference.ok)
      expect(compiled.completed).toEqual(reference.completed)
      expect(compiled.values.get("touched")).toBe(reference.values.get("touched"))
    })
  }
})

describe("structural kinds", () => {
  test("sequence runs children in order", async () => {
    const catalog = createStepCatalog({
      s: { kind: "task", run: (ctx) => ctx.set(ctx.nodeId, ctx.nodeId) },
    })
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [
        {
          id: "seq",
          kind: "sequence",
          children: [
            { id: "x", kind: "task", step: "s" },
            { id: "y", kind: "task", step: "s" },
          ],
        },
      ],
    }
    const result = await run(compile(plan, catalog))
    expect(result.ok).toBe(true)
    expect(result.completed).toEqual(["x", "y"])
  })

  test("parallel honors the lower of plan, host, and breadth", async () => {
    const measure = (): { catalog: StepCatalog; peak: () => number } => {
      let active = 0
      let peak = 0
      const catalog = createStepCatalog({
        s: {
          kind: "task",
          run: async () => {
            active++
            peak = Math.max(peak, active)
            await new Promise((r) => setTimeout(r, 5))
            active--
          },
        },
      })
      return { catalog, peak: () => peak }
    }
    const plan = (maxConcurrency?: number): RunPlan => ({
      version: 1,
      id: "p",
      nodes: [
        {
          id: "par",
          kind: "parallel",
          ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
          children: [
            { id: "a", kind: "task", step: "s" },
            { id: "b", kind: "task", step: "s" },
            { id: "c", kind: "task", step: "s" },
          ],
        },
      ],
    })

    const unbounded = measure()
    await run(compile(plan(), unbounded.catalog))
    expect(unbounded.peak()).toBe(3)

    const planCapped = measure()
    await run(compile(plan(1), planCapped.catalog))
    expect(planCapped.peak()).toBe(1)

    const hostCapped = measure()
    await run(compile(plan(), hostCapped.catalog, { maxParallel: 2 }))
    expect(hostCapped.peak()).toBe(2)
  })

  test("retry re-runs a flaky child until it succeeds", async () => {
    let attempts = 0
    const catalog = createStepCatalog({
      flaky: {
        kind: "task",
        run: () => {
          attempts++
          if (attempts < 3) throw new Error("not yet")
          return "ok"
        },
      },
    })
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [
        { id: "r", kind: "retry", attempts: 3, child: { id: "c", kind: "task", step: "flaky" } },
      ],
    }
    const result = await run(compile(plan, catalog))
    expect(result.ok).toBe(true)
    expect(attempts).toBe(3)
  })

  test("branch selects then or otherwise from a content-free predicate", async () => {
    const catalog = createStepCatalog({
      gate: { kind: "branch", when: (ctx) => ctx.values.get("go") === true },
      mark: { kind: "task", run: (ctx) => ctx.set("path", ctx.nodeId) },
    })
    const plan = (): RunPlan => ({
      version: 1,
      id: "p",
      nodes: [
        { id: "seed", kind: "task", step: "seed" },
        {
          id: "br",
          kind: "branch",
          step: "gate",
          dependsOn: ["seed"],
          // biome-ignore lint/suspicious/noThenProperty: RunPlan branch nodes name their arms then/otherwise.
          then: { id: "then", kind: "task", step: "mark" },
          otherwise: { id: "else", kind: "task", step: "mark" },
        },
      ],
    })
    const withSeed = (go: boolean): StepCatalog =>
      mergeStepCatalogs(
        catalog,
        createStepCatalog({ seed: { kind: "task", run: (ctx) => ctx.set("go", go) } }),
      )

    const taken = await run(compile(plan(), withSeed(true)))
    expect(taken.values.get("path")).toBe("then")
    const skipped = await run(compile(plan(), withSeed(false)))
    expect(skipped.values.get("path")).toBe("else")
  })

  test("subagent node runs through the bounded runner", async () => {
    const catalog = createStepCatalog({
      child: {
        kind: "subagent",
        executor: { run: () => "child-output" },
        spec: (ctx) => ({ id: "kid-1", role: "impl", prompt: `do ${ctx.nodeId}` }),
      },
    })
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [{ id: "sa", kind: "subagent", step: "child" }],
    }
    const result = await run(compile(plan, catalog))
    expect(result.ok).toBe(true)
    expect(result.completed).toEqual(["sa"])
  })

  test("a failing subagent fails the node", async () => {
    const catalog = createStepCatalog({
      child: {
        kind: "subagent",
        executor: {
          run: () => {
            throw new Error("boom")
          },
        },
        spec: () => ({ id: "kid-1", role: "impl", prompt: "do" }),
      },
    })
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [{ id: "sa", kind: "subagent", step: "child" }],
    }
    const result = await run(compile(plan, catalog))
    expect(result.ok).toBe(false)
  })
})

describe("ceilings and authority fail closed before work", () => {
  const catalog = createStepCatalog({
    s: { kind: "task", run: () => undefined, capabilities: ["fs"], version: 2 },
    plain: { kind: "task", run: () => undefined },
  })

  test("one-over the node ceiling is rejected", () => {
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [
        {
          id: "par",
          kind: "parallel",
          children: [
            { id: "a", kind: "task", step: "plain" },
            { id: "b", kind: "task", step: "plain" },
          ],
        },
      ],
    }
    // parallel + 2 children = 3 nodes; ceiling 2 -> reject.
    expect(() => compile(plan, catalog, { maxNodes: 2 })).toThrow(/nodes over the 2 ceiling/)
    try {
      compile(plan, catalog, { maxNodes: 2 })
    } catch (error) {
      expect((error as CompileError).code).toBe("E_MAX_NODES")
    }
  })

  test("depth ceiling is rejected", () => {
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [
        {
          id: "seq",
          kind: "sequence",
          children: [
            { id: "inner", kind: "sequence", children: [{ id: "a", kind: "task", step: "plain" }] },
          ],
        },
      ],
    }
    try {
      compile(plan, catalog, { maxDepth: 1 })
      throw new Error("expected compile to throw")
    } catch (error) {
      expect((error as CompileError).code).toBe("E_MAX_DEPTH")
    }
  })

  test("an ungranted capability is rejected", () => {
    const plan: RunPlan = { version: 1, id: "p", nodes: [{ id: "a", kind: "task", step: "s" }] }
    try {
      compile(plan, catalog, { allowedCapabilities: [] })
      throw new Error("expected compile to throw")
    } catch (error) {
      expect((error as CompileError).code).toBe("E_CAPABILITY")
    }
  })

  test("a granted capability compiles", () => {
    const plan: RunPlan = { version: 1, id: "p", nodes: [{ id: "a", kind: "task", step: "s" }] }
    expect(() => compile(plan, catalog, { allowedCapabilities: ["fs"] })).not.toThrow()
  })

  test("a pinned version drift is rejected", () => {
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [{ id: "a", kind: "task", step: "s", stepVersion: 1 }],
    }
    try {
      compile(plan, catalog, { allowedCapabilities: ["fs"] })
      throw new Error("expected compile to throw")
    } catch (error) {
      expect((error as CompileError).code).toBe("E_VERSION_DRIFT")
    }
  })

  test("unknown step and kind mismatch are rejected", () => {
    expect(() =>
      compile({ version: 1, id: "p", nodes: [{ id: "a", kind: "task", step: "nope" }] }, catalog),
    ).toThrow(/unknown step/)
    expect(() =>
      compile(
        { version: 1, id: "p", nodes: [{ id: "a", kind: "verify", step: "plain" }] },
        catalog,
      ),
    ).toThrow(/does not match/)
  })

  test("a dependency cycle is rejected", () => {
    const plan: RunPlan = {
      version: 1,
      id: "p",
      nodes: [
        { id: "a", kind: "task", step: "plain", dependsOn: ["b"] },
        { id: "b", kind: "task", step: "plain", dependsOn: ["a"] },
      ],
    }
    expect(() => compile(plan, catalog)).toThrow(/cycle/)
  })

  test("merged catalogs reject a duplicate key", () => {
    const a = createStepCatalog({ dup: { kind: "task", run: () => undefined } })
    const b = createStepCatalog({ dup: { kind: "task", run: () => undefined } })
    expect(() => mergeStepCatalogs(a, b)).toThrow(/duplicate step key/)
  })
})

describe("parser rejects illegal structure", () => {
  test("a nested child may not declare dependsOn", () => {
    const plan = {
      version: 1,
      id: "p",
      nodes: [
        {
          id: "seq",
          kind: "sequence",
          children: [{ id: "a", kind: "task", step: "s", dependsOn: ["b"] }],
        },
      ],
    }
    expect(() => parseRunPlan(plan)).toThrow(/nested and may not declare dependsOn/)
  })

  test("retry attempts are bounded", () => {
    const plan = {
      version: 1,
      id: "p",
      nodes: [
        { id: "r", kind: "retry", attempts: 99, child: { id: "c", kind: "task", step: "s" } },
      ],
    }
    expect(() => parseRunPlan(plan)).toThrow(RunContractError)
  })

  test("a structural node may not carry a step (except branch)", () => {
    const plan = {
      version: 1,
      id: "p",
      nodes: [
        {
          id: "seq",
          kind: "sequence",
          step: "s",
          children: [{ id: "a", kind: "task", step: "s" }],
        },
      ],
    }
    expect(() => parseRunPlan(plan)).toThrow(/unknown key 'step'/)
  })
})

describe("realistic pipeline (exit criterion 1)", () => {
  test("planner, two parallel implementers, approval, verify, handoff completes", async () => {
    const catalog = createStepCatalog({
      plan: { kind: "task", run: (ctx) => ctx.set("plan", "ready") },
      impl: { kind: "task", run: (ctx) => ctx.set(ctx.nodeId, "done") },
      approveGate: { kind: "approve", run: () => true },
      verifyGate: { kind: "verify", run: () => true },
      handoffOut: { kind: "handoff", run: (ctx) => ctx.set("handed", ctx.nodeId) },
    })
    const plan: RunPlan = {
      version: 1,
      id: "pipeline",
      nodes: [
        { id: "planner", kind: "task", step: "plan" },
        {
          id: "build",
          kind: "parallel",
          dependsOn: ["planner"],
          children: [
            { id: "impl-a", kind: "task", step: "impl" },
            { id: "impl-b", kind: "task", step: "impl" },
          ],
        },
        {
          id: "gate",
          kind: "approve",
          step: "approveGate",
          reason: "human sign-off",
          dependsOn: ["build"],
        },
        { id: "check", kind: "verify", step: "verifyGate", dependsOn: ["gate"] },
        { id: "ship", kind: "handoff", step: "handoffOut", dependsOn: ["check"] },
      ],
    }
    const result = await run(compile(plan, catalog, { maxParallel: 2, maxNodes: 32 }))
    expect(result.ok).toBe(true)
    expect(new Set(result.completed)).toEqual(
      new Set(["planner", "impl-a", "impl-b", "gate", "check", "ship"]),
    )
  })
})
