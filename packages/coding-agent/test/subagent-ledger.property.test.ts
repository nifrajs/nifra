import { expect, test } from "bun:test"
import fc from "fast-check"
import {
  BoundedSubagentRunner,
  type SubagentResult,
  type SubagentWorkspaceLease,
} from "../src/subagents.ts"

/**
 * The child ledger against a model of what it promises: a slot is held by every child whose executor
 * started, and by every child still acquiring its workspace, including one whose run was cancelled
 * while its acquisition goes on. Nothing else holds one, and no more than `maxChildren` are ever held.
 * Runs start, acquire, fail, escape, get cancelled and finish in random order, overlapping.
 */

const ROOT = process.cwd()

type Phase = "refused" | "acquiring" | "late" | "executing" | "finished" | "released"

interface Model {
  readonly max: number
  readonly phases: Phase[]
}

interface Run {
  readonly result: Promise<SubagentResult>
  readonly controller: AbortController
  readonly lease: PromiseWithResolvers<SubagentWorkspaceLease>
  readonly executor: PromiseWithResolvers<string>
  readonly reached: Promise<"acquiring" | "executing" | "settled">
  cleanedUp: number
}

interface Real {
  readonly children: { started: number }
  readonly runs: Run[]
  readonly reach: Array<(stage: "acquiring" | "executing") => void>
}

const holds = (phase: Phase): boolean => phase !== "refused" && phase !== "released"
const held = (m: Model): number => m.phases.filter(holds).length

/** One event-loop turn: a released late lease gives its slot back a few reactions later. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

function start(r: Real, spec: Parameters<BoundedSubagentRunner["run"]>[0], max: number): Run {
  const index = r.runs.length
  const lease = Promise.withResolvers<SubagentWorkspaceLease>()
  // A lease the run never asked for is still rejected when the case is torn down.
  lease.promise.catch(() => {})
  const executor = Promise.withResolvers<string>()
  const stage = Promise.withResolvers<"acquiring" | "executing">()
  r.reach[index] = stage.resolve
  const controller = new AbortController()
  const runner = new BoundedSubagentRunner(
    {
      run: ({ signal }) => {
        r.reach[index]?.("executing")
        signal.addEventListener("abort", () => executor.reject(new Error("aborted")), {
          once: true,
        })
        return executor.promise
      },
    },
    {
      maxChildren: max,
      children: r.children,
      allowedCapabilities: ["read"],
      signal: controller.signal,
      workspace: {
        root: ROOT,
        isolatedWorktree: () => {
          r.reach[index]?.("acquiring")
          return lease.promise
        },
      },
    },
  )
  const result = runner.run(spec)
  const run: Run = {
    result,
    controller,
    lease,
    executor,
    reached: Promise.race([stage.promise, result.then(() => "settled" as const)]),
    cleanedUp: 0,
  }
  r.runs.push(run)
  return run
}

const leaseFor = (run: Run): SubagentWorkspaceLease => ({
  cwd: ROOT,
  cleanup: () => {
    run.cleanedUp++
  },
})

function pick(m: Model, index: number, ...phases: Phase[]): number {
  const eligible = m.phases.flatMap((phase, i) => (phases.includes(phase) ? [i] : []))
  return eligible[index % eligible.length] ?? -1
}

const has = (m: Model, ...phases: Phase[]) => m.phases.some((phase) => phases.includes(phase))

function settles(r: Real, m: Model): void {
  expect(r.children.started).toBe(held(m))
  expect(r.children.started).toBeLessThanOrEqual(m.max)
}

class StartValid implements fc.AsyncCommand<Model, Real> {
  check = () => true
  async run(m: Model, r: Real) {
    const run = start(r, { id: `run-${r.runs.length}`, role: "worker", prompt: "x" }, m.max)
    const full = held(m) >= m.max
    m.phases.push(full ? "refused" : "acquiring")
    expect(await run.reached).toBe(full ? "settled" : "acquiring")
    if (full) expect(await run.result).toMatchObject({ error: "subagent child limit exceeded" })
    settles(r, m)
  }
  toString = () => "StartValid"
}

/** Specs the runner refuses before taking a slot, with the error each is refused with. */
const INVALID = [
  [{ id: "Not An Id", role: "worker", prompt: "x" }, "invalid subagent id"],
  [{ id: "empty", role: "worker", prompt: "" }, "subagent prompt is empty or too long"],
  [
    { id: "writer", role: "worker", prompt: "x", capabilities: ["write"] },
    "subagent capability denied: write",
  ],
  [
    { id: "outside", role: "worker", prompt: "x", cwd: "/" },
    "subagent workspace escapes policy root",
  ],
] as const

class StartInvalid implements fc.AsyncCommand<Model, Real> {
  constructor(readonly refused: (typeof INVALID)[number]) {}
  check = () => true
  async run(m: Model, r: Real) {
    const [spec, error] = this.refused
    const run = start(r, spec, m.max)
    m.phases.push("refused")
    expect(await run.reached).toBe("settled")
    expect(await run.result).toMatchObject({ ok: false, error })
    settles(r, m)
  }
  toString = () => `StartInvalid(${this.refused[1]})`
}

class Grant implements fc.AsyncCommand<Model, Real> {
  constructor(readonly index: number) {}
  check = (m: Readonly<Model>) => has(m, "acquiring")
  async run(m: Model, r: Real) {
    const i = pick(m, this.index, "acquiring")
    const run = r.runs[i]
    if (run === undefined) throw new Error("no such run")
    const executing = Promise.withResolvers<"executing">()
    r.reach[i] = () => executing.resolve("executing")
    run.lease.resolve(leaseFor(run))
    m.phases[i] = "executing"
    expect(await Promise.race([executing.promise, run.result.then(() => "settled")])).toBe(
      "executing",
    )
    settles(r, m)
  }
  toString = () => `Grant(${this.index})`
}

class Deny implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly index: number,
    readonly how: "reject" | "escape",
  ) {}
  check = (m: Readonly<Model>) => has(m, "acquiring")
  async run(m: Model, r: Real) {
    const i = pick(m, this.index, "acquiring")
    const run = r.runs[i]
    if (run === undefined) throw new Error("no such run")
    if (this.how === "reject") run.lease.reject(new Error("no worktree"))
    else run.lease.resolve({ ...leaseFor(run), cwd: "/" })
    m.phases[i] = "released"
    expect(await run.result).toMatchObject({
      ok: false,
      error: this.how === "reject" ? "no worktree" : "isolated worktree escapes workspace policy",
    })
    settles(r, m)
  }
  toString = () => `Deny(${this.index}, ${this.how})`
}

class Cancel implements fc.AsyncCommand<Model, Real> {
  constructor(readonly index: number) {}
  check = (m: Readonly<Model>) => has(m, "acquiring", "executing")
  async run(m: Model, r: Real) {
    const i = pick(m, this.index, "acquiring", "executing")
    const run = r.runs[i]
    if (run === undefined) throw new Error("no such run")
    // A cancelled acquisition goes on, holding its slot; a started executor keeps its slot for good.
    m.phases[i] = m.phases[i] === "acquiring" ? "late" : "finished"
    run.controller.abort()
    expect(await run.result).toMatchObject({ ok: false, error: "subagent cancelled" })
    settles(r, m)
  }
  toString = () => `Cancel(${this.index})`
}

class LateSettle implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly index: number,
    readonly granted: boolean,
  ) {}
  check = (m: Readonly<Model>) => has(m, "late")
  async run(m: Model, r: Real) {
    const i = pick(m, this.index, "late")
    const run = r.runs[i]
    if (run === undefined) throw new Error("no such run")
    if (this.granted) run.lease.resolve(leaseFor(run))
    else run.lease.reject(new Error("no worktree"))
    m.phases[i] = "released"
    await turn()
    // A lease that lands after the run gave up is released unused.
    expect(run.cleanedUp).toBe(this.granted ? 1 : 0)
    settles(r, m)
  }
  toString = () => `LateSettle(${this.index}, ${this.granted ? "granted" : "failed"})`
}

class Finish implements fc.AsyncCommand<Model, Real> {
  constructor(readonly index: number) {}
  check = (m: Readonly<Model>) => has(m, "executing")
  async run(m: Model, r: Real) {
    const i = pick(m, this.index, "executing")
    const run = r.runs[i]
    if (run === undefined) throw new Error("no such run")
    run.executor.resolve("done")
    m.phases[i] = "finished"
    expect(await run.result).toMatchObject({ ok: true, output: "done" })
    expect(run.cleanedUp).toBe(1)
    settles(r, m)
  }
  toString = () => `Finish(${this.index})`
}

const index = fc.nat({ max: 7 })
const commands = fc.commands(
  [
    fc.constant(new StartValid()),
    fc.constantFrom(...INVALID).map((refused) => new StartInvalid(refused)),
    index.map((i) => new Grant(i)),
    fc
      .tuple(index, fc.constantFrom("reject" as const, "escape" as const))
      .map(([i, how]) => new Deny(i, how)),
    index.map((i) => new Cancel(i)),
    fc.tuple(index, fc.boolean()).map(([i, granted]) => new LateSettle(i, granted)),
    index.map((i) => new Finish(i)),
  ],
  { maxCommands: 40, size: "large" },
)

test("model: the child ledger holds a slot exactly while a child runs or still acquires", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 3 }), commands, async (max, cmds) => {
      const real: Real = { children: { started: 0 }, runs: [], reach: [] }
      await fc.asyncModelRun(() => ({ model: { max, phases: [] }, real }), cmds)
      // Leave nothing pending for the next case.
      for (const run of real.runs) {
        run.lease.reject(new Error("done"))
        run.executor.resolve("done")
        run.controller.abort()
      }
      await Promise.all(real.runs.map((run) => run.result))
    }),
    { numRuns: 150 },
  )
})
