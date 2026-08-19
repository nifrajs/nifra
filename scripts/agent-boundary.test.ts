import { describe, expect, test } from "bun:test"
import { findAgentBoundaryFailures } from "./check-agent-boundary.ts"

describe("agent package boundary", () => {
  test("keeps framework packages free of agent and Workbench imports", async () => {
    expect(await findAgentBoundaryFailures()).toEqual([])
  })
})
