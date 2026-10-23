import { describe, expect, test } from "bun:test"
import {
  AgentDeployment,
  type AgentDeploymentAdapter,
  assertDeploymentAuthorityMonotonic,
  createDeploymentAuthority,
  DeploymentError,
  parseDeploymentCapabilityReport,
  parseDeploymentPlan,
} from "../src/index.ts"

function referenceAdapter(id = "local"): AgentDeploymentAdapter {
  return {
    id,
    capabilityReport: () => ({
      schemaVersion: 1 as const,
      adapterId: id,
      capabilities: {
        runtime: "local" as const,
        network: "none" as const,
        filesystem: "workspace" as const,
        process: "child" as const,
        secrets: "none" as const,
        workspace: { mode: "scoped" as const, maxBytes: 10_000_000 },
        cancellation: "cooperative" as const,
        hostileCodeIsolation: "none" as const,
      },
      limitations: ["not-a-sandbox"],
    }),
    prepare: ({ plan }: { plan: { deploymentId: string } }) => ({
      deploymentId: plan.deploymentId,
      state: "prepared" as const,
      preparedRef: `${plan.deploymentId}:prepared`,
    }),
    start: ({ deploymentId }: { deploymentId: string }) => ({
      deploymentId,
      state: "running" as const,
      handleRef: `${deploymentId}:handle`,
    }),
    inspect: ({ deploymentId }: { deploymentId: string }) => ({
      deploymentId,
      state: "running" as const,
      handleRef: `${deploymentId}:handle`,
    }),
    cancel: ({ deploymentId }: { deploymentId: string }) => ({
      deploymentId,
      state: "cancelled" as const,
    }),
    dispose: ({ deploymentId }: { deploymentId: string }) => ({
      deploymentId,
      state: "disposed" as const,
    }),
  }
}

describe("deployment lifecycle contracts", () => {
  test("runs deterministic prepare, start, inspect, cancel, and dispose", async () => {
    const deployment = new AgentDeployment(
      referenceAdapter(),
      createDeploymentAuthority({ workspaceMaxBytes: 1024 * 1024 }),
    )
    await deployment.prepare({ deploymentId: "run-1", workspaceMaxBytes: 1024 })
    await deployment.start()
    expect((await deployment.inspect()).state).toBe("running")
    await deployment.cancel()
    await deployment.dispose()
    expect(deployment.lifecycleState).toBe("disposed")
    expect(deployment.evidenceRecords.some((item) => item.kind === "disposed")).toBe(true)
  })

  test("rejects hostile-code plans for non-sandboxed local and replay profiles", async () => {
    for (const adapter of [referenceAdapter("local"), referenceAdapter("replay")]) {
      const deployment = new AgentDeployment(
        adapter,
        createDeploymentAuthority({ workspaceMaxBytes: 1024 * 1024 }),
      )
      await expect(
        deployment.prepare({ deploymentId: "hostile", hostileCode: true }),
      ).rejects.toMatchObject({
        code: "hostile_code_requires_isolation",
      })
    }
  })

  test("rejects authority expansion before child activation", () => {
    const parent = createDeploymentAuthority({ workspaceMaxBytes: 100, deadlineAt: 1000 })
    expect(() =>
      assertDeploymentAuthorityMonotonic(parent, {
        workspaceMaxBytes: 101,
        deadlineAt: 1000,
        cancellation: "cooperative",
        hostileCodeIsolation: "none",
      }),
    ).toThrow(DeploymentError)
  })

  test("rejects contradictory capability reports", () => {
    expect(() =>
      parseDeploymentCapabilityReport({
        schemaVersion: 1,
        adapterId: "bad",
        capabilities: {
          runtime: "replay",
          network: "none",
          filesystem: "none",
          process: "none",
          secrets: "none",
          workspace: { mode: "none", maxBytes: 1 },
          cancellation: "cooperative",
          hostileCodeIsolation: "os",
        },
        limitations: [],
      }),
    ).toThrow(DeploymentError)
  })
})

describe("deployment lifecycle ordering", () => {
  const authority = () => createDeploymentAuthority({ workspaceMaxBytes: 1024 * 1024 })

  test("a cancel during start waits for it and cancels the workload it started", async () => {
    const cancelled: (string | undefined)[] = []
    const deployment = new AgentDeployment(
      {
        ...referenceAdapter(),
        start: async ({ deploymentId }) => {
          await Bun.sleep(20)
          return { deploymentId, state: "running" as const, handleRef: "workload" }
        },
        cancel: ({ deploymentId, handleRef }) => {
          cancelled.push(handleRef)
          return { deploymentId, state: "cancelled" as const }
        },
      },
      authority(),
    )
    await deployment.prepare({ deploymentId: "run-1" })
    const starting = deployment.start()
    await Bun.sleep(1)
    expect((await deployment.cancel()).state).toBe("cancelled")
    await starting
    expect(cancelled).toEqual(["workload"])
    expect(deployment.lifecycleState).toBe("cancelled")
    expect(deployment.evidenceRecords.map((item) => item.kind)).toEqual([
      "prepared",
      "started",
      "cancelled",
    ])
  })

  test("a start that honors the cancel signal settles as cancelled", async () => {
    const deployment = new AgentDeployment(
      {
        ...referenceAdapter(),
        start: ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })
          }),
      },
      authority(),
    )
    await deployment.prepare({ deploymentId: "run-2" })
    const starting = deployment.start()
    await Bun.sleep(1)
    expect((await deployment.cancel()).state).toBe("cancelled")
    await expect(starting).rejects.toMatchObject({ code: "cancelled" })
    expect(deployment.lifecycleState).toBe("cancelled")
  })

  test("a refused plan is recorded as failed evidence", async () => {
    const deployment = new AgentDeployment(referenceAdapter(), authority())
    await expect(
      deployment.prepare({ deploymentId: "hostile", hostileCode: true }),
    ).rejects.toMatchObject({ code: "hostile_code_requires_isolation" })
    await expect(deployment.prepare({ nope: true })).rejects.toMatchObject({ code: "invalid_plan" })
    expect(deployment.evidenceRecords.map((item) => item.code)).toEqual([
      "hostile_code_requires_isolation",
      "invalid_plan",
    ])
  })
})

describe("deployment contract refusals", () => {
  const code = (run: () => unknown): string | undefined => {
    try {
      run()
    } catch (error) {
      return error instanceof DeploymentError ? error.code : "not-a-deployment-error"
    }
    return undefined
  }

  test("a plan with a stray field or an unbounded value is invalid", () => {
    for (const plan of [
      null,
      { deploymentId: "run-1", extra: true },
      { deploymentId: "not a token" },
      { deploymentId: "run-1", hostileCode: "yes" },
      { deploymentId: "run-1", workspaceMaxBytes: -1 },
      { deploymentId: "run-1", deadlineAt: "soon" },
      { deploymentId: "run-1", deadlineAt: 0 },
    ])
      expect(code(() => parseDeploymentPlan(plan))).toBe("invalid_plan")
    expect(parseDeploymentPlan({ deploymentId: "run-1", deadlineAt: 5 })).toEqual({
      deploymentId: "run-1",
      deadlineAt: 5,
    })
  })

  test("a capability report with an unknown class or bad limitations is invalid", () => {
    const report = referenceAdapter().capabilityReport()
    for (const broken of [
      "report",
      { ...report, limitations: ["not a token"] },
      { ...report, capabilities: { ...report.capabilities, runtime: "mars" } },
    ])
      expect(code(() => parseDeploymentCapabilityReport(broken))).toBe("invalid_capabilities")
  })

  test("a child authority may only narrow its parent's", () => {
    const authority = {
      workspaceMaxBytes: 100,
      cancellation: "cooperative",
      hostileCodeIsolation: "none",
    } as const
    expect(code(() => createDeploymentAuthority({ workspaceMaxBytes: 1, deadlineAt: 0 }))).toBe(
      "authority_expanded",
    )
    expect(
      code(() =>
        assertDeploymentAuthorityMonotonic(authority, {
          ...authority,
          cancellation: "always" as never,
        }),
      ),
    ).toBe("authority_expanded")
    const widened: [Parameters<typeof assertDeploymentAuthorityMonotonic>[0], object][] = [
      [{ ...authority, deadlineAt: 10 }, {}],
      [{ ...authority, cancellation: "none" }, { cancellation: "cooperative" }],
      [{ ...authority }, { cancellation: "forced" }],
      [{ ...authority }, { hostileCodeIsolation: "os" }],
    ]
    for (const [parent, change] of widened)
      expect(
        code(() => assertDeploymentAuthorityMonotonic(parent, { ...authority, ...change })),
      ).toBe("authority_expanded")
    expect(
      code(() =>
        assertDeploymentAuthorityMonotonic(
          { ...authority, deadlineAt: 10 },
          { ...authority, deadlineAt: 5 },
        ),
      ),
    ).toBeUndefined()
  })
})

describe("deployment lifecycle refusals", () => {
  const authority = () => createDeploymentAuthority({ workspaceMaxBytes: 1024 * 1024 })
  const deploy = (adapter: Partial<AgentDeploymentAdapter> = {}, options = {}) =>
    new AgentDeployment(
      { ...referenceAdapter(), ...adapter } as AgentDeploymentAdapter,
      authority(),
      undefined,
      options,
    )
  const fails = async (run: Promise<unknown>) => {
    try {
      await run
    } catch (error) {
      return error instanceof DeploymentError ? error.code : "not-a-deployment-error"
    }
    return undefined
  }

  test("each step out of order is an invalid transition", async () => {
    const deployment = deploy()
    expect(await fails(deployment.start())).toBe("invalid_transition")
    expect(await fails(deployment.inspect())).toBe("invalid_transition")
    expect(await fails(deployment.cancel())).toBe("invalid_transition")
    expect(deployment.evidenceRecords.map((record) => record.kind)).toEqual([
      "failed",
      "failed",
      "failed",
    ])
  })

  test("a report for another adapter is refused at prepare", async () => {
    const deployment = deploy({
      capabilityReport: () => ({ ...referenceAdapter().capabilityReport(), adapterId: "other" }),
    })
    expect(await fails(deployment.prepare({ deploymentId: "run-1" }))).toBe("invalid_capabilities")
  })

  test("a plan beyond the adapter or the authority is refused at prepare", async () => {
    const tight = (plan: object, adapter: Partial<AgentDeploymentAdapter> = {}, options = {}) =>
      fails(deploy(adapter, options).prepare({ deploymentId: "run-1", ...plan }))
    expect(await tight({ hostileCode: true })).toBe("hostile_code_requires_isolation")
    const isolated = {
      capabilityReport: () => {
        const report = referenceAdapter().capabilityReport()
        return { ...report, capabilities: { ...report.capabilities, hostileCodeIsolation: "os" } }
      },
    } as Partial<AgentDeploymentAdapter>
    expect(
      await fails(
        new AgentDeployment(
          { ...referenceAdapter(), ...isolated } as AgentDeploymentAdapter,
          createDeploymentAuthority({ workspaceMaxBytes: 1024, hostileCodeIsolation: "os" }),
        ).prepare({ deploymentId: "run-1", hostileCode: true }),
      ),
    ).toBe("hostile_code_requires_isolation")
    expect(await tight({ workspaceMaxBytes: 20_000_000 })).toBe("capability_denied")
    expect(
      await fails(
        new AgentDeployment(
          referenceAdapter(),
          createDeploymentAuthority({ workspaceMaxBytes: 10 }),
        ).prepare({ deploymentId: "run-1", workspaceMaxBytes: 100 }),
      ),
    ).toBe("authority_expanded")
    const cancellable = {
      capabilityReport: () => {
        const report = referenceAdapter().capabilityReport()
        return { ...report, capabilities: { ...report.capabilities, cancellation: "none" } }
      },
    } as Partial<AgentDeploymentAdapter>
    expect(await tight({}, cancellable)).toBe("capability_denied")
    expect(
      await fails(
        new AgentDeployment(
          referenceAdapter(),
          createDeploymentAuthority({ workspaceMaxBytes: 1024, deadlineAt: 100 }),
        ).prepare({ deploymentId: "run-1", deadlineAt: 200 }),
      ),
    ).toBe("authority_expanded")
  })

  test("an adapter that throws or answers out of shape fails its step", async () => {
    const boom = () => {
      throw new Error("adapter crashed")
    }
    expect(await fails(deploy({ prepare: boom }).prepare({ deploymentId: "run-1" }))).toBe(
      "adapter_error",
    )
    expect(
      await fails(
        deploy({
          prepare: () => ({ deploymentId: "run-1", state: "prepared", preparedRef: "not a ref" }),
        }).prepare({ deploymentId: "run-1" }),
      ),
    ).toBe("malformed_callback")
    const started = async (adapter: Partial<AgentDeploymentAdapter>) => {
      const deployment = deploy(adapter)
      await deployment.prepare({ deploymentId: "run-1" })
      return deployment
    }
    expect(await fails((await started({ start: boom })).start())).toBe("adapter_error")
    expect(
      await fails(
        (await started({ start: () => ({ deploymentId: "run-1", state: "prepared" }) })).start(),
      ),
    ).toBe("malformed_callback")
    const running = async (adapter: Partial<AgentDeploymentAdapter>) => {
      const deployment = await started(adapter)
      await deployment.start()
      return deployment
    }
    expect(
      await fails(
        (
          await running({ inspect: () => ({ deploymentId: "run-1", state: "exploded" }) })
        ).inspect(),
      ),
    ).toBe("malformed_callback")
    expect(
      await fails((await running({ inspect: () => ({ deploymentId: "run-1" }) })).inspect()),
    ).toBe("malformed_callback")
    expect(await fails((await running({ cancel: boom })).cancel())).toBe("adapter_error")
    expect(
      await fails(
        (await running({ cancel: () => ({ deploymentId: "run-1", state: "disposed" }) })).cancel(),
      ),
    ).toBe("malformed_callback")
  })
})
