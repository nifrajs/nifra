import { describe, expect, test } from "bun:test"
import {
  AgentDeployment,
  type AgentDeploymentAdapter,
  assertDeploymentAuthorityMonotonic,
  createDeploymentAuthority,
  DeploymentError,
  parseDeploymentCapabilityReport,
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
