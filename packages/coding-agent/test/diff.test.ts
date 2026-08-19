import { describe, expect, test } from "bun:test"
import { readProjectDiff } from "../src/diff.ts"

describe("project diff", () => {
  test("returns a bounded, non-interactive git diff", async () => {
    const result = await readProjectDiff({ cwd: process.cwd(), maxOutputBytes: 16 * 1024 * 1024 })
    expect(result.ok).toBe(true)
    expect(result.status).toBe(0)
    expect(typeof result.output).toBe("string")
  })

  test("rejects unsafe resource limits", async () => {
    await expect(readProjectDiff({ cwd: process.cwd(), timeoutMs: 0 })).rejects.toThrow("timeoutMs")
    await expect(readProjectDiff({ cwd: process.cwd(), maxOutputBytes: 512 })).rejects.toThrow(
      "maxOutputBytes",
    )
  })
})
