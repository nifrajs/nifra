import { describe, expect, test } from "bun:test"
import type { AgentBackend } from "@nifrajs/agent-protocol"
import { composeReviewReport } from "@nifrajs/agent-review"
import { CodingAgentRpcServer } from "../src/rpc.ts"
import { runNifraReview } from "../src/verification.ts"

const DIGEST = "a".repeat(64)

async function passReport(): Promise<unknown> {
  return composeReviewReport({
    strict: false,
    scope: {
      kind: "project",
      state: "valid",
      changedPaths: [],
      pathDigest: DIGEST,
      outOfScopeCount: 0,
    },
    checks: [],
    findings: [],
  })
}

async function failReport(): Promise<unknown> {
  return composeReviewReport({
    strict: false,
    scope: {
      kind: "project",
      state: "valid",
      changedPaths: [],
      pathDigest: DIGEST,
      outOfScopeCount: 0,
    },
    checks: [
      {
        id: "security",
        required: true,
        status: "fail",
        duration: "fast",
        counts: { findings: 1, errors: 1, warnings: 0, info: 0, outOfScope: 0 },
        findingIds: ["finding-1"],
        evidence: [{ source: "check", token: "r-check", digest: DIGEST }],
      },
    ],
    findings: [
      {
        id: "finding-1",
        check: "security",
        code: "NF-S001",
        severity: "error",
        category: "security",
        evidence: [{ source: "check", token: "r-finding", digest: DIGEST }],
      },
    ],
  })
}

function emitScript(value: unknown, exitCode?: number): string {
  return `process.stdout.write(${JSON.stringify(JSON.stringify(value))}); process.exit(${exitCode ?? 0})`
}

const backend: AgentBackend = {
  info: { name: "review-test", capabilities: [] },
  async createSession(input) {
    return {
      version: 1,
      id: input.sessionId ?? "review-session",
      backend: "review-test",
      cwd: process.cwd(),
      status: "idle",
      createdAt: 0,
      updatedAt: 0,
      lastSeq: 0,
      capabilities: [],
    }
  },
  async *send() {
    yield* []
  },
  async cancel() {},
  async snapshot() {
    throw new Error("snapshot is not used by this test")
  },
  async reload() {
    return { loaded: [], disabled: [], revision: "0", rolledBack: false }
  },
  async close() {},
}

describe("bounded coding-agent review execution", () => {
  test("parses a valid pass and preserves a valid failing report without raw output", async () => {
    const pass = await passReport()
    const passed = await runNifraReview({
      cwd: process.cwd(),
      command: process.execPath,
      commandArgs: ["-e", emitScript(pass)],
    })
    expect(passed).toMatchObject({
      name: "review",
      ok: true,
      status: 0,
      report: { status: "pass" },
    })
    expect(passed).not.toHaveProperty("output")
    expect(passed).not.toHaveProperty("error")

    const failed = await runNifraReview({
      cwd: process.cwd(),
      command: process.execPath,
      commandArgs: ["-e", emitScript(await failReport(), 1)],
    })
    expect(failed).toMatchObject({
      name: "review",
      ok: false,
      status: 1,
      report: { status: "fail" },
    })
    expect(failed).not.toHaveProperty("output")
  })

  test("rejects malformed or oversized child output with stable codes", async () => {
    const malformed = await runNifraReview({
      cwd: process.cwd(),
      command: process.execPath,
      commandArgs: ["-e", 'process.stdout.write(JSON.stringify({ secret: "never-returned" }))'],
    })
    expect(malformed).toEqual({ name: "review", ok: false, status: 0, errorCode: "invalid-report" })
    expect(JSON.stringify(malformed)).not.toContain("never-returned")

    const oversized = await runNifraReview({
      cwd: process.cwd(),
      maxOutputBytes: 32,
      command: process.execPath,
      commandArgs: ["-e", 'process.stdout.write("x".repeat(256))'],
    })
    expect(oversized.errorCode).toBe("output-truncated")
    expect(oversized).not.toHaveProperty("output")
  })

  test("kills a review process that exceeds its bounded timeout", async () => {
    const timedOut = await runNifraReview({
      cwd: process.cwd(),
      timeoutMs: 10,
      command: process.execPath,
      commandArgs: ["-e", "await Bun.sleep(250)"],
    })
    expect(timedOut.name).toBe("review")
    expect(timedOut.ok).toBe(false)
    expect(timedOut.errorCode).toBe("timeout")
    expect(timedOut).not.toHaveProperty("report")
  })

  test("rejects unsafe diff selectors before spawning a child", async () => {
    await expect(
      runNifraReview({
        cwd: process.cwd(),
        diff: "../outside",
        command: process.execPath,
        commandArgs: ["-e", "process.exit(99)"],
      }),
    ).rejects.toThrow("safe Git ref")
  })

  test("RPC validates its narrow request and forwards only bounded review output", async () => {
    const report = await passReport()
    const rpc = new CodingAgentRpcServer({
      cwd: process.cwd(),
      backend,
      verification: {
        command: process.execPath,
        commandArgs: ["-e", emitScript(report)],
      },
    })
    const handle = await rpc.start()
    const headers = {
      authorization: `Bearer ${handle.token}`,
      "content-type": "application/json",
    }
    try {
      const invalid = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "review.run", params: { write: true } }),
      })
      expect(invalid.status).toBe(422)
      expect(await invalid.json()).toEqual({
        error: { code: "invalid_review", message: "review accepts only strict and diff" },
      })

      const response = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "review.run", params: { strict: true } }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as Record<string, unknown>
      expect(body).toMatchObject({
        name: "review",
        ok: true,
        status: 0,
        report: { status: "pass" },
      })
      expect(body).not.toHaveProperty("output")
      expect(body).not.toHaveProperty("error")
    } finally {
      await rpc.stop()
    }
  })
})
