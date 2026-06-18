import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectTestResult } from "../src/test-tool.ts"

describe("collectTestResult", () => {
  test("runs bun test with a safe pattern and returns bounded structured output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-test-tool-"))
    try {
      await mkdir(join(dir, "test"))
      await writeFile(
        join(dir, "test/sample.test.ts"),
        'import { expect, test } from "bun:test"\ntest("ok", () => expect(1 + 1).toBe(2))\n',
      )
      const result = await collectTestResult(dir, {
        pattern: "test/sample.test.ts",
        timeoutMs: 20_000,
      })
      expect(result.ok).toBe(true)
      expect(result.command).toEqual(["bun", "test", "test/sample.test.ts"])
      expect(result.summary.passed).toBeGreaterThanOrEqual(1)
      expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(24_500)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects CLI flags in pattern", async () => {
    const result = await collectTestResult("/tmp", { pattern: "--preload=evil.ts" })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not a CLI flag")
  })

  test("cancels an in-flight bun test process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-test-tool-"))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort("stop tests"), 50)
    try {
      await mkdir(join(dir, "test"))
      await writeFile(
        join(dir, "test/hangs.test.ts"),
        [
          'import { test } from "bun:test"',
          'test("hangs", async () => {',
          "  await new Promise(() => {})",
          "})",
          "",
        ].join("\n"),
      )
      const result = await collectTestResult(
        dir,
        { pattern: "test/hangs.test.ts", timeoutMs: 20_000 },
        { signal: controller.signal },
      )
      expect(result.ok).toBe(false)
      expect(result.cancelled).toBe(true)
      expect(result.timedOut).toBe(false)
      expect(result.error).toBe("cancelled: stop tests")
    } finally {
      clearTimeout(timer)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
