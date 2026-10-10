import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { checkAgentBackend } from "@nifrajs/agent-protocol/conformance"
import { AcpBackend } from "../src/index.ts"

const AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url))

test("AcpBackend passes the agent backend conformance kit", async () => {
  const report = await checkAgentBackend({
    backend: () => new AcpBackend({ command: process.execPath, args: [AGENT] }),
    cwd: tmpdir(),
    prompt: "hello",
    slowPrompt: "slow",
    approvalPrompt: "approve",
  })
  expect(report.checks.filter((check) => check.status !== "passed")).toEqual([])
  expect(report.backend).toBe("acp")
  expect(report.ok).toBe(true)
})
