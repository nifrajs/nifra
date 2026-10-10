import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createVerificationRepairTask,
  isVerificationAvailable,
  runNifraVerification,
} from "../src/verification.ts"

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
      let pids: number[] = []
      let running: ReturnType<typeof runNifraVerification> | undefined
      try {
        const pidFile = join(dir, "grandchild.pid")
        const parentTerm = join(dir, "parent.term")
        const grandchildTerm = join(dir, "grandchild.term")
        const script = join(dir, "stubborn.ts")
        const grandchildScript = [
          `import { writeFileSync } from "node:fs"`,
          `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(grandchildTerm)}, "ignored"))`,
          `console.log("ready")`,
          `setInterval(() => {}, 1000)`,
        ].join("\n")
        await writeFile(
          script,
          [
            `import { writeFileSync } from "node:fs"`,
            `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(parentTerm)}, "ignored"))`,
            `const grandchild = Bun.spawn([process.execPath, "-e", ${JSON.stringify(grandchildScript)}], { stdout: "pipe", stderr: "inherit" })`,
            `const reader = grandchild.stdout.getReader()`,
            `const ready = await reader.read()`,
            `if (new TextDecoder().decode(ready.value).trim() !== "ready") throw new Error("grandchild did not become ready")`,
            `reader.releaseLock()`,
            `writeFileSync(${JSON.stringify(pidFile)}, [process.pid, grandchild.pid].join("\\n"))`,
            `setInterval(() => {}, 1000)`,
          ].join("\n"),
        )
        running = runNifraVerification("check", {
          cwd: dir,
          command: process.execPath,
          commandArgs: [script],
          timeoutMs: 500,
        })
        for (let attempt = 0; !(await Bun.file(pidFile).exists()) && attempt < 50; attempt++)
          await Bun.sleep(10)
        pids = (await Bun.file(pidFile).text()).split("\n").map(Number)
        expect(pids).toHaveLength(2)
        expect(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)).toBe(true)
        const result = await running
        const exits = await Promise.all(pids.map(waitForProcessExit))
        expect(result.ok).toBe(false)
        expect(result.error).toContain("timed out")
        // SIGKILL reaches both processes, but the OS can remove the descendant PID after the direct
        // child's exit has settled. Observe that state with a bound rather than racing one probe.
        expect(exits).toEqual([true, true])
        expect(await Bun.file(parentTerm).text()).toBe("ignored")
        expect(await Bun.file(grandchildTerm).text()).toBe("ignored")
      } finally {
        try {
          pids.forEach(terminateProcess)
        } finally {
          await running
          await rm(dir, { recursive: true, force: true })
        }
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

  test("a gate whose command is missing reports unavailable and asks for no repair", async () => {
    const result = await runNifraVerification("check", {
      cwd: tmpdir(),
      command: "nifra-gate-that-is-not-installed",
    })
    expect(result).toMatchObject({ name: "check", ok: false, status: null, unavailable: true })
    expect(result.error).toContain("nifra-gate-that-is-not-installed")
    expect(createVerificationRepairTask(result, tmpdir())).toBeUndefined()
  })

  test("a missing working directory is a failure, not a missing gate", async () => {
    const result = await runNifraVerification("check", {
      cwd: join(tmpdir(), "nifra-verify-no-such-dir"),
      command: process.execPath,
    })
    expect(result.ok).toBe(false)
    expect(result.unavailable).toBeUndefined()
  })

  test("reports whether a gate's command can run without running it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-verify-probe-"))
    try {
      const script = join(dir, "gate.sh")
      await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      expect(isVerificationAvailable("test", { cwd: dir })).toBe(true)
      expect(isVerificationAvailable("check", { cwd: dir, command: process.execPath })).toBe(true)
      expect(isVerificationAvailable("check", { cwd: dir, command: "./gate.sh" })).toBe(true)
      expect(isVerificationAvailable("check", { cwd: dir, command: "./missing.sh" })).toBe(false)
      expect(
        isVerificationAvailable("check", { cwd: dir, command: "nifra-gate-that-is-not-installed" }),
      ).toBe(false)
      expect(
        isVerificationAvailable("check", { cwd: dir, command: "sh", env: { PATH: dir } }),
      ).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function processExited(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
      return true
    throw error
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (processExited(pid)) return true
    await Bun.sleep(10)
  }
  return processExited(pid)
}

function terminateProcess(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || processExited(pid)) return
  // A failed assertion must not leave the intentionally stubborn fixture running.
  try {
    process.kill(pid, "SIGKILL")
  } catch (error) {
    // The PID can disappear between the liveness check and the cleanup signal.
    if (!processExited(pid)) throw error
  }
}
