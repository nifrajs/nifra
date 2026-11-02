import { describe, expect, test } from "bun:test"
import { watch } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectTestResult } from "../src/test-tool.ts"

/** Whether `pid` is a zombie: exited but not yet reaped. Only Linux exposes this, as `Z` in `/proc/<pid>/stat`. */
async function isZombie(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z"
  } catch {
    return false
  }
}

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

  test("keeps only the head and tail of a test run that prints without limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-test-tool-"))
    try {
      await mkdir(join(dir, "test"))
      await writeFile(
        join(dir, "test/loud.test.ts"),
        'import { expect, test } from "bun:test"\ntest("loud", () => {\n  const line = "x".repeat(1023)\n  for (let i = 0; i < 2048; i++) console.log(line)\n  expect(1).toBe(1)\n})\n',
      )
      const result = await collectTestResult(dir, {
        pattern: "test/loud.test.ts",
        timeoutMs: 60_000,
      })
      expect(result.ok).toBe(true)
      expect(result.summary.passed).toBe(1)
      expect(result.stdout).toMatch(/…\(trimmed more than \d+ bytes\)…/)
      expect(result.stdout.length).toBeLessThanOrEqual(12_100)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects CLI flags in pattern", async () => {
    const result = await collectTestResult("/tmp", { pattern: "--preload=evil.ts" })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not a CLI flag")
  })

  test("runs no test file outside the project, by relative, absolute or symlinked path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-test-tool-"))
    try {
      await mkdir(join(dir, "project"))
      await writeFile(
        join(dir, "outside.test.ts"),
        'import { test } from "bun:test"\ntest("outside", () => console.log("RAN-OUTSIDE"))\n',
      )
      await symlink(dir, join(dir, "project/escape"))
      for (const pattern of [
        "../outside.test.ts",
        "./../outside.test.ts",
        join(dir, "outside.test.ts"),
        "./escape/outside.test.ts",
      ]) {
        const result = await collectTestResult(join(dir, "project"), { pattern })
        expect(result.ok).toBe(false)
        expect(result.error).toContain("inside the selected project directory")
        expect(result.stdout + result.stderr).not.toContain("RAN-OUTSIDE")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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

  // A process outliving its parent can only be reached through a POSIX process group.
  test.skipIf(process.platform === "win32")(
    "stopping a run also stops a process it started that holds the output pipes",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "nifra-test-tool-"))
      const controller = new AbortController()
      const watcher = watch(dir, (_event, name) => {
        if (name === "grandchild.pid") controller.abort("stop tests")
      })
      try {
        await mkdir(join(dir, "test"))
        await writeFile(
          join(dir, "test/spawns.test.ts"),
          [
            'import { writeFileSync } from "node:fs"',
            'import { test } from "bun:test"',
            'test("spawns", async () => {',
            '  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {',
            '    stdout: "inherit",',
            '    stderr: "inherit",',
            "  })",
            '  writeFileSync(new URL("../grandchild.pid", import.meta.url), String(child.pid))',
            "  await new Promise(() => {})",
            "}, 600_000)",
            "",
          ].join("\n"),
        )
        const result = await collectTestResult(
          dir,
          { pattern: "test/spawns.test.ts", timeoutMs: 120_000 },
          { signal: controller.signal },
        )
        expect(result.cancelled).toBe(true)
        const pid = Number(await readFile(join(dir, "grandchild.pid"), "utf8"))
        // The group has been signalled, but an orphan's PID can remain until the OS reaps it, and where
        // nothing reaps orphans (a container without an init) it stays a zombie for good: the process
        // is dead, yet `kill(pid, 0)` still succeeds. Observe the bounded state change, and count a
        // zombie as exited, instead of racing the first liveness probe.
        let exited = false
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            process.kill(pid, 0)
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
            exited = true
            break
          }
          if (await isZombie(pid)) {
            exited = true
            break
          }
          await Bun.sleep(10)
        }
        expect(exited).toBe(true)
      } finally {
        watcher.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )
})
