import { describe, expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { createLocalProcessAdapter, LOCAL_PROCESS_LIMITATION } from "../src/execution-policy.ts"

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
