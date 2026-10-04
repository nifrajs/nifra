import { describe, expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createLocalProcessAdapter,
  LOCAL_PROCESS_LIMITATION,
  windowsTreeKill,
} from "../src/execution-policy.ts"

describe("local execution policy adapter", () => {
  test("filters env and reports its non-boundary limitation", async () => {
    const adapter = createLocalProcessAdapter({ envAllowlist: ["PATH"] })
    const result = await adapter.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.HIDDEN ?? 'absent')"],
      env: { HIDDEN: "secret-value" },
      capability: "process.run",
      policy: {
        filesystem: "cwd",
        network: "allow",
        timeMs: 500,
        capabilityCeiling: ["process.run"],
      },
    })
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe("absent")
    expect(result.limitations).toContain(LOCAL_PROCESS_LIMITATION)
  })

  test("kills a process that exceeds its time budget", async () => {
    const adapter = createLocalProcessAdapter()
    const result = await adapter.run({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 500)"],
      policy: {
        filesystem: "cwd",
        network: "allow",
        timeMs: 20,
        capabilityCeiling: ["process.run"],
      },
    })
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
  })

  test("escalates to SIGKILL when a timed-out process ignores SIGTERM", async () => {
    const adapter = createLocalProcessAdapter()
    const result = await adapter.run({
      command: process.execPath,
      args: ["-e", 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000)'],
      policy: {
        filesystem: "cwd",
        network: "allow",
        timeMs: 50,
        capabilityCeiling: ["process.run"],
      },
    })
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    // POSIX exposes the escalation signal. Windows' child-process layer reports the terminating
    // signal as SIGTERM even when the second kill is the operation that closes the child; timeout
    // and completion are the portable contract there.
    expect(result.signal).toBe(process.platform === "win32" ? "SIGTERM" : "SIGKILL")
  }, 10_000)

  const policy = (timeMs: number) => ({
    filesystem: "cwd" as const,
    network: "allow" as const,
    timeMs,
    capabilityCeiling: ["process.run"],
  })
  const gone = async (pid: number): Promise<boolean> => {
    // An exited process can linger as a zombie for a moment before it is reaped.
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        process.kill(pid, 0)
      } catch {
        return true
      }
      await Bun.sleep(20)
    }
    return false
  }

  test.skipIf(process.platform === "win32")(
    "a timeout ends every process the command started",
    async () => {
      const started = performance.now()
      const result = await createLocalProcessAdapter().run({
        command: "sh",
        args: ["-c", "sleep 30 & echo $!; wait"],
        policy: policy(200),
      })
      expect(result.timedOut).toBe(true)
      expect(performance.now() - started).toBeLessThan(1500)
      expect(await gone(Number(result.stdout.trim()))).toBe(true)
    },
  )

  test.skipIf(process.platform === "win32")(
    "a timeout stops waiting on a process that left the group but holds the pipes",
    async () => {
      const script = [
        'const { spawn } = require("node:child_process")',
        'const options = { detached: true, stdio: ["ignore", "inherit", "inherit"] }',
        'const escaped = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], options)',
        "console.log(escaped.pid)",
        "setTimeout(() => {}, 30000)",
      ].join("\n")
      const started = performance.now()
      const result = await createLocalProcessAdapter().run({
        command: process.execPath,
        args: ["-e", script],
        policy: policy(100),
      })
      const escaped = Number(result.stdout.trim())
      if (escaped > 0) process.kill(escaped, "SIGKILL")
      expect(result.timedOut).toBe(true)
      expect(performance.now() - started).toBeLessThan(5000)
    },
    10_000,
  )

  test.skipIf(process.platform === "win32")(
    "a host that exits mid-run takes the run's process group with it",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "nifra-exec-exit-"))
      const pidFile = join(dir, "pid")
      const host = [
        `import { existsSync, readFileSync } from "node:fs"`,
        `import { createLocalProcessAdapter } from ${JSON.stringify(join(import.meta.dir, "../src/execution-policy.ts"))}`,
        `const pidFile = ${JSON.stringify(pidFile)}`,
        `void createLocalProcessAdapter().run({ command: "sh", args: ["-c", "sleep 30 & echo $! > " + pidFile + "; wait"], policy: ${JSON.stringify(policy(30_000))} })`,
        `while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") await Bun.sleep(10)`,
        "process.exit(0)",
      ].join("\n")
      try {
        const child = Bun.spawn([process.execPath, "-e", host], {
          stdout: "ignore",
          stderr: "inherit",
        })
        expect(await child.exited).toBe(0)
        const pid = Number((await Bun.file(pidFile).text()).trim())
        expect(pid).toBeGreaterThan(0)
        expect(await gone(pid)).toBe(true)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    10_000,
  )

  test.skipIf(process.platform === "win32")(
    "a background process the command leaves behind ends with the run",
    async () => {
      const result = await createLocalProcessAdapter().run({
        command: "sh",
        args: ["-c", "sleep 30 > /dev/null 2>&1 & echo $!"],
        policy: policy(5_000),
      })
      expect(result.ok).toBe(true)
      expect(await gone(Number(result.stdout.trim()))).toBe(true)
    },
  )

  test("a Windows run's process tree is ended with taskkill", () => {
    const calls: unknown[] = []
    windowsTreeKill(4242, (command, args, options) => {
      calls.push([command, args, options])
      return { on: () => undefined }
    })
    expect(calls).toEqual([
      ["taskkill", ["/pid", "4242", "/T", "/F"], { stdio: "ignore", windowsHide: true }],
    ])
  })

  test("a command that cannot start rejects as an invalid request", async () => {
    await expect(
      createLocalProcessAdapter().run({
        command: join(tmpdir(), "nifra-missing-command"),
        args: [],
        policy: policy(1_000),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  test("a time budget past the timer range still waits for the process", async () => {
    const result = await createLocalProcessAdapter().run({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 100)"],
      policy: policy(30 * 24 * 60 * 60 * 1000),
    })
    expect(result.timedOut).toBe(false)
    expect(result.ok).toBe(true)
  })

  // `maxOutputBytes` is one budget over the whole capture, not one per stream. Two independent
  // counters let a process that writes to both pipes buffer twice the configured ceiling.
  test("stdout and stderr share one output budget", async () => {
    const adapter = createLocalProcessAdapter({ maxOutputBytes: 10 })
    const result = await adapter.run({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("o".repeat(1000)); process.stderr.write("e".repeat(1000))',
      ],
      policy: {
        filesystem: "cwd",
        network: "allow",
        timeMs: 5_000,
        capabilityCeiling: ["process.run"],
      },
    })
    expect(result.stdout.length + result.stderr.length).toBe(10)
  })

  test("rejects a non-positive maxOutputBytes at construction", () => {
    expect(() => createLocalProcessAdapter({ maxOutputBytes: 0 })).toThrow(/maxOutputBytes/)
    expect(() => createLocalProcessAdapter({ maxOutputBytes: 1.5 })).toThrow(/maxOutputBytes/)
  })

  test("rejects a working directory outside the adapter cwd", async () => {
    const adapter = createLocalProcessAdapter({ cwd: process.cwd() })
    await expect(
      adapter.run({
        command: process.execPath,
        args: ["-e", ""],
        cwd: "..",
        policy: {
          filesystem: "cwd",
          network: "allow",
          timeMs: 100,
          capabilityCeiling: ["process.run"],
        },
      }),
    ).rejects.toMatchObject({ code: "policy_unsatisfied" })
  })

  test("successful runs do not retain listeners on a shared abort signal", async () => {
    const adapter = createLocalProcessAdapter()
    const controller = new AbortController()
    for (let i = 0; i < 12; i++) {
      const result = await adapter.run({
        command: process.execPath,
        args: ["-e", ""],
        signal: controller.signal,
        policy: {
          filesystem: "cwd",
          network: "allow",
          timeMs: 1_000,
          capabilityCeiling: ["process.run"],
        },
      })
      expect(result.ok).toBe(true)
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  })
})
