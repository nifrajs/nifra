import { describe, expect, test } from "bun:test"
import { AgentDeployment, createDeploymentAuthority } from "@nifrajs/agent"
import {
  createCiDeploymentAdapter,
  createLocalProcessDeploymentAdapter,
  createReplayDeploymentAdapter,
} from "../src/index.ts"

describe("reference deployment adapters", () => {
  test("report truthful non-sandbox capabilities and clean up", async () => {
    for (const adapter of [
      createLocalProcessDeploymentAdapter(),
      createCiDeploymentAdapter(),
      createReplayDeploymentAdapter(),
    ]) {
      const report = await adapter.capabilityReport()
      expect(report.capabilities.hostileCodeIsolation).toBe("none")
      const deployment = new AgentDeployment(
        adapter,
        createDeploymentAuthority({ workspaceMaxBytes: 1024 * 1024 }),
      )
      await deployment.prepare({ deploymentId: `deploy-${adapter.id}` })
      await deployment.start()
      await deployment.dispose()
      expect(deployment.lifecycleState).toBe("disposed")
    }
  })
})
