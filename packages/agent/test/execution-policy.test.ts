import { describe, expect, test } from "bun:test"
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
    expect(result.signal).toBe("SIGKILL")
  }, 10_000)

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
})
