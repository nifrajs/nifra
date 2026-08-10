import { describe, expect, test } from "bun:test"
import { defineTool, runToolContractConformance } from "@nifrajs/core/tool-contract"
import { t } from "@nifrajs/schema"
import {
  httpToolAdapter,
  inProcessToolAdapter,
  mcpToolAdapter,
  testToolAdapter,
} from "../src/tool-contract.ts"

describe("tool adapter conformance matrix", () => {
  test("all public adapters share the same enforcement pipeline", async () => {
    const tool = defineTool({
      name: "matrix.echo",
      description: "Conformance echo tool.",
      input: t.object({ name: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "matrix.echo",
      approval: { kind: "required" },
      execute: () => ({ ok: true }),
    })
    const adapters = [
      inProcessToolAdapter(tool),
      testToolAdapter(tool),
      httpToolAdapter(tool),
      mcpToolAdapter(tool),
    ]
    const results = []
    for (const adapter of adapters) {
      results.push(
        await runToolContractConformance(adapter, {
          input: { name: "Ada" },
          capability: "matrix.echo",
          approval: { granted: true },
          dryRun: {},
        }),
      )
    }
    expect(results.map((result) => result.adapter)).toEqual(["in-process", "test", "http", "mcp"])
    expect(results.every((result) => result.checks.length === 3)).toBe(true)
  })
})
