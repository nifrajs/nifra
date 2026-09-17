import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findCommandSpec } from "../src/command-catalog.ts"
import { catalogProjectTools } from "../src/mcp-exec.ts"
import type { McpToolContext } from "../src/mcp-protocol.ts"

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nifra-review-mcp-"))
  await mkdir(join(root, "node_modules", "typescript", "bin"), { recursive: true })
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "review-mcp-fixture" }))
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ files: [] }))
  await writeFile(join(root, "node_modules", "typescript", "bin", "tsc"), "process.exit(0)\n")
  return root
}

const context: McpToolContext = {
  signal: new AbortController().signal,
  requestId: "review-test",
  reportProgress: () => {},
}

describe("nifra_review MCP projection", () => {
  test("is generated from the same command catalog and has no parallel handler", () => {
    const spec = findCommandSpec("review")
    expect(spec).toBeDefined()
    const tools = catalogProjectTools("/fake", async () => {
      throw new Error("review must not load the web app")
    })
    const review = tools.find((tool) => tool.name === "nifra_review")
    expect(review).toBeDefined()
    expect(review?.description).toBe(spec?.summary)
    expect(review?.inputSchema).toEqual(spec?.input.jsonSchema)
  })

  test("uses the same report serializer and digest as the CLI command", async () => {
    const root = await project()
    try {
      const tool = catalogProjectTools(root).find((candidate) => candidate.name === "nifra_review")
      expect(tool).toBeDefined()
      const output = await tool!.handler({}, context)
      expect(typeof output).toBe("string")
      const report = JSON.parse(output as string) as { status: string; digest: string; ok: boolean }

      const direct = (await findCommandSpec("review")!.run({}, { cwd: root })) as {
        status: string
        digest: string
        ok: boolean
      }
      expect(report).toMatchObject({ status: direct.status, digest: direct.digest, ok: direct.ok })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects invalid input before a collector can run and does not expose an exception", async () => {
    const root = await project()
    try {
      const tool = catalogProjectTools(root).find((candidate) => candidate.name === "nifra_review")!
      const output = JSON.parse((await tool.handler({ dryRun: true }, context)) as string) as {
        ok: boolean
        error: string
      }
      expect(output).toEqual({ ok: false, error: "dryRun requires fix" })
      expect(JSON.stringify(output)).not.toContain("stack")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("returns an inconclusive report for an invalid ref instead of writing a tool error", async () => {
    const root = await project()
    try {
      const tool = catalogProjectTools(root).find((candidate) => candidate.name === "nifra_review")!
      const output = JSON.parse(
        (await tool.handler({ diff: "no-such-ref" }, context)) as string,
      ) as {
        status: string
        scope: {
          kind: string
          state: string
          changedPaths: readonly string[]
          pathDigest: string
          outOfScopeCount: number
          reasonCode?: string
        }
      }
      expect(output.status).toBe("inconclusive")
      expect(output.scope).toEqual({
        kind: "diff",
        state: "invalid",
        changedPaths: [],
        pathDigest: "0".repeat(64),
        outOfScopeCount: 0,
        reasonCode: "invalid-git-ref",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
