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

  test.skipIf(process.platform === "win32")(
    "a timeout ends a child that ignores SIGTERM and the process it started",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "nifra-verify-timeout-"))
      try {
        const pidFile = join(dir, "grandchild.pid")
        const script = join(dir, "stubborn.ts")
        await writeFile(
          script,
          [
            `const grandchild = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdout: "inherit", stderr: "inherit" })`,
            `await Bun.write(${JSON.stringify(pidFile)}, String(grandchild.pid))`,
            `process.on("SIGTERM", () => {})`,
            `setInterval(() => {}, 1000)`,
          ].join("\n"),
        )
        const result = await runNifraVerification("check", {
          cwd: dir,
          command: process.execPath,
          commandArgs: [script],
          timeoutMs: 500,
        })
        expect(result.ok).toBe(false)
        expect(result.error).toContain("timed out")
        const grandchild = Number(await Bun.file(pidFile).text())
        expect(() => process.kill(grandchild, 0)).toThrow()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

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
