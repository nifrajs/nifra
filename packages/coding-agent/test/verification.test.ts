import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { createVerificationRepairTask, runNifraVerification } from "../src/verification.ts"

describe("runNifraVerification", () => {
  test("returns bounded structured output", async () => {
    const result = await runNifraVerification("check", {
      cwd: tmpdir(),
      command: process.execPath,
    })
    expect(result.ok).toBe(false)
    expect(result.status).not.toBeNull()
  })

  test("turns a failed gate into a bounded repair task", () => {
    const task = createVerificationRepairTask(
      { name: "check", ok: false, status: 1, output: "diagnostic" },
      process.cwd(),
    )
    expect(task?.verification).toBe("check")
    expect(task?.capabilities).toContain("write")
    expect(
      createVerificationRepairTask({ name: "assure", ok: true, status: 0 }, process.cwd()),
    ).toBeUndefined()
  })
})
