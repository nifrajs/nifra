import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  test("the test gate runs the project's suite with bun test", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-verify-test-"))
    try {
      const suite = (body: string) =>
        writeFile(join(dir, "gate.test.ts"), `import { expect, test } from "bun:test"\n${body}\n`)
      await suite('test("passes", () => expect(1).toBe(1))')
      expect((await runNifraVerification("test", { cwd: dir })).ok).toBe(true)
      await suite('test("fails", () => expect(1).toBe(2))')
      const failed = await runNifraVerification("test", { cwd: dir })
      expect(failed.ok).toBe(false)
      expect(failed.status).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
