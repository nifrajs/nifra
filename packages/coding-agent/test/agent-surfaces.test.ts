import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createCapabilityManifest,
  deniedCapabilities,
  parseCapabilityManifest,
} from "../src/capabilities.ts"
import {
  BoundedSubagentRunner,
  type SubagentAbandonment,
  type SubagentAbandonmentLedger,
} from "../src/subagents.ts"

/** An executor that ignores its abort signal and runs until `finish()`. */
function stuckExecutor() {
  let entered = (): void => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let finish = (): void => {}
  return {
    started,
    finish: () => finish(),
    run: (): Promise<void> => {
      entered()
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    },
  }
}

describe("optional agent safety surfaces", () => {
  test("parses capability manifests and fails closed on denied capabilities", () => {
    const manifest = createCapabilityManifest(
      ["filesystem.read", "process.exec"],
      ["filesystem.read"],
      "run the verifier",
    )
    expect(deniedCapabilities(manifest)).toEqual(["process.exec"])
    expect(parseCapabilityManifest(manifest)).toEqual(manifest)
    expect(() =>
      parseCapabilityManifest({ version: 1, requested: ["unknown"], trusted: [] }),
    ).toThrow("unknown capability")
  })

  test("enforces workspace policy and forwards the selected cwd", async () => {
    const runner = new BoundedSubagentRunner(
      {
        run: async ({ cwd }) => cwd,
      },
      { workspace: { root: process.cwd() } },
    )
    await expect(
      runner.run({ id: "inside", role: "reviewer", prompt: "inspect", cwd: process.cwd() }),
    ).resolves.toMatchObject({ ok: true, output: process.cwd() })
    await expect(
      runner.run({ id: "outside", role: "reviewer", prompt: "inspect", cwd: "/tmp" }),
    ).resolves.toMatchObject({ ok: false, error: "subagent workspace escapes policy root" })
  })

  test("a timeout ends a run whose executor ignores the signal", async () => {
    const runner = new BoundedSubagentRunner({ run: () => new Promise(() => {}) })
    await expect(
      runner.run({ id: "stuck", role: "reviewer", prompt: "inspect", timeoutMs: 20 }),
    ).resolves.toEqual({ id: "stuck", role: "reviewer", ok: false, error: "subagent timed out" })
  })

  // The workspace checks before an executor starts do real I/O, so a short timeout can stop the run
  // before the executor exists. Tests about a running executor stop it once it has started.
  test("a stopped run releases its workspace only once the executor settles", async () => {
    const events: string[] = []
    const parent = new AbortController()
    const executor = stuckExecutor()
    const runner = new BoundedSubagentRunner(
      {
        run: () =>
          executor.run().then(() => {
            events.push("executor done")
          }),
      },
      {
        signal: parent.signal,
        workspace: {
          root: process.cwd(),
          isolatedWorktree: () => ({
            cwd: process.cwd(),
            cleanup: () => {
              events.push("cleanup")
            },
          }),
        },
      },
    )
    const running = runner.run({ id: "stuck", role: "worker", prompt: "edit" })
    await executor.started
    parent.abort()
    await expect(running).resolves.toMatchObject({ ok: false, error: "subagent cancelled" })
    expect(events).toEqual([])
    executor.finish()
    await Bun.sleep(0)
    expect(events).toEqual(["executor done", "cleanup"])
  })

  test("a run that times out while its worktree is prepared releases it at once and never starts the executor", async () => {
    const events: string[] = []
    let runs = 0
    const runner = new BoundedSubagentRunner(
      {
        run: () => {
          runs += 1
          return "ran"
        },
      },
      {
        workspace: {
          root: process.cwd(),
          isolatedWorktree: (_spec, signal) =>
            new Promise((resolve) => {
              const lease = (): void => {
                events.push("lease")
                resolve({
                  cwd: process.cwd(),
                  cleanup: () => {
                    events.push("cleanup")
                  },
                })
              }
              if (signal.aborted) lease()
              else signal.addEventListener("abort", lease, { once: true })
            }),
        },
      },
    )
    await expect(
      runner.run({ id: "slow-setup", role: "worker", prompt: "edit", timeoutMs: 5 }),
    ).resolves.toMatchObject({ ok: false, error: "subagent timed out" })
    expect(events).toEqual(["lease", "cleanup"])
    expect(runs).toBe(0)
  })

  test("an executor that ignores its abort is reported abandoned and counted until it settles", async () => {
    const seen: SubagentAbandonment[] = []
    const parent = new AbortController()
    const executor = stuckExecutor()
    const runner = new BoundedSubagentRunner(executor, {
      signal: parent.signal,
      workspace: { root: process.cwd() },
      onAbandoned: (abandonment) => seen.push(abandonment),
    })
    const running = runner.run({ id: "stuck", role: "worker", prompt: "edit" })
    await executor.started
    parent.abort()
    await expect(running).resolves.toMatchObject({ ok: false, error: "subagent cancelled" })
    expect(runner.abandoned).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      spec: { id: "stuck" },
      reason: "cancelled",
      cwd: realpathSync(process.cwd()),
    })
    executor.finish()
    await seen[0]?.settled
    expect(runner.abandoned).toBe(0)
  })

  test("a timed-out executor is reported abandoned with the timeout as its reason", async () => {
    const seen: SubagentAbandonment[] = []
    const executor = stuckExecutor()
    // No workspace: nothing before the executor awaits I/O, so it starts before a timer can fire.
    const runner = new BoundedSubagentRunner(executor, {
      onAbandoned: (abandonment) => seen.push(abandonment),
    })
    await expect(
      runner.run({ id: "stuck", role: "worker", prompt: "edit", timeoutMs: 20 }),
    ).resolves.toMatchObject({ ok: false, error: "subagent timed out" })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ reason: "timeout", cwd: undefined })
    executor.finish()
    await seen[0]?.settled
    expect(runner.abandoned).toBe(0)
  })

  test("an executor that honours its abort is not abandoned", async () => {
    const seen: SubagentAbandonment[] = []
    const parent = new AbortController()
    const runner = new BoundedSubagentRunner(
      {
        run: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })
          }),
      },
      { signal: parent.signal, onAbandoned: (abandonment) => seen.push(abandonment) },
    )
    const running = runner.run({ id: "polite", role: "worker", prompt: "edit" })
    await Bun.sleep(5)
    parent.abort()
    await expect(running).resolves.toMatchObject({ ok: false, error: "subagent cancelled" })
    expect(seen).toEqual([])
    expect(runner.abandoned).toBe(0)
  })

  test("maxAbandoned refuses new children while that many abandoned executors run, across a shared ledger", async () => {
    let finish = (): void => {}
    const stuck = {
      run: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    }
    const ledger: SubagentAbandonmentLedger = { abandoned: 0 }
    const first = new BoundedSubagentRunner(stuck, { maxAbandoned: 1, abandonment: ledger })
    const second = new BoundedSubagentRunner(
      { run: () => "ran" },
      { maxAbandoned: 1, abandonment: ledger },
    )
    await expect(
      first.run({ id: "stuck", role: "worker", prompt: "edit", timeoutMs: 20 }),
    ).resolves.toMatchObject({ ok: false, error: "subagent timed out" })
    expect(ledger.abandoned).toBe(1)
    const next = { id: "next", role: "worker", prompt: "edit" }
    await expect(second.run(next)).resolves.toMatchObject({
      ok: false,
      error: "subagent abandoned-executor limit reached",
    })
    finish()
    await Bun.sleep(0)
    expect(second.abandoned).toBe(0)
    await expect(second.run(next)).resolves.toMatchObject({ ok: true, output: "ran" })
    expect(() => new BoundedSubagentRunner(stuck, { maxAbandoned: -1 })).toThrow(RangeError)
  })

  test("a finished run is released before it returns, and a cancelled one never leases", async () => {
    const events: string[] = []
    const workspace = {
      root: process.cwd(),
      isolatedWorktree: () => {
        events.push("lease")
        return {
          cwd: process.cwd(),
          cleanup: () => {
            events.push("cleanup")
          },
        }
      },
    }
    const spec = { id: "child", role: "worker", prompt: "edit" }
    await expect(
      new BoundedSubagentRunner({ run: () => "ran" }, { workspace }).run(spec),
    ).resolves.toMatchObject({ ok: true, output: "ran" })
    expect(events).toEqual(["lease", "cleanup"])
    events.length = 0
    const parent = new AbortController()
    parent.abort()
    await expect(
      new BoundedSubagentRunner({ run: () => "ran" }, { workspace, signal: parent.signal }).run(
        spec,
      ),
    ).resolves.toMatchObject({ ok: false, error: "subagent cancelled" })
    expect(events).toEqual([])
  })

  test("an already-aborted parent signal cancels before the executor starts", async () => {
    let runs = 0
    const parent = new AbortController()
    parent.abort()
    const runner = new BoundedSubagentRunner(
      {
        run: () => {
          runs += 1
          return "done"
        },
      },
      { signal: parent.signal },
    )
    await expect(
      runner.run({ id: "late", role: "reviewer", prompt: "inspect" }),
    ).resolves.toMatchObject({ ok: false, error: "subagent cancelled" })
    expect(runs).toBe(0)
  })

  test("a symlink inside the workspace root does not lead a subagent out of it", async () => {
    const base = mkdtempSync(join(tmpdir(), "nifra-subagent-"))
    try {
      const root = join(base, "root")
      mkdirSync(join(root, "inside"), { recursive: true })
      mkdirSync(join(base, "outside"))
      symlinkSync(join(base, "outside"), join(root, "escape"))
      symlinkSync(join(root, "inside"), join(root, "alias"))
      let runs = 0
      const runner = new BoundedSubagentRunner(
        {
          run: ({ cwd }) => {
            runs += 1
            return cwd
          },
        },
        { workspace: { root } },
      )
      const spec = { id: "child", role: "worker", prompt: "edit" }
      await expect(runner.run({ ...spec, cwd: "escape" })).resolves.toMatchObject({
        ok: false,
        error: "subagent workspace escapes policy root",
      })
      await expect(runner.run({ ...spec, cwd: "escape/not-yet-created" })).resolves.toMatchObject({
        ok: false,
      })
      expect(runs).toBe(0)
      // A link that stays inside the root, and a directory not created yet, still run.
      await expect(runner.run({ ...spec, cwd: "alias" })).resolves.toMatchObject({ ok: true })
      await expect(runner.run({ ...spec, cwd: "inside/new" })).resolves.toMatchObject({ ok: true })

      // The executor gets the checked path with its links resolved: swapping the link it came
      // through, after the check, cannot move the executor outside the root.
      const swapped = new BoundedSubagentRunner(
        {
          run: ({ cwd }) => {
            rmSync(join(root, "alias"))
            symlinkSync(join(base, "outside"), join(root, "alias"))
            return cwd === undefined ? undefined : realpathSync(cwd)
          },
        },
        { workspace: { root } },
      )
      await expect(swapped.run({ ...spec, cwd: "alias" })).resolves.toMatchObject({
        ok: true,
        output: realpathSync(join(root, "inside")),
      })

      const leased = new BoundedSubagentRunner(
        { run: () => "ran" },
        {
          workspace: {
            root,
            isolatedWorktree: () => ({ cwd: join(root, "escape") }),
          },
        },
      )
      await expect(leased.run(spec)).resolves.toMatchObject({
        ok: false,
        error: "isolated worktree escapes workspace policy",
      })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
