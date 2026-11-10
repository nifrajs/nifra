import { expect as check, describe, test } from "bun:test"
import {
  type CacheMode,
  type CacheOptions,
  E2EError,
  type E2EModel,
  e2e,
  expect,
  formatReport,
  type ModelRequest,
  memoryCacheStore,
  Secret,
  unique,
} from "../src/index.ts"
import { virtualClock } from "./helpers.ts"
import { app, lastAct, refusing, solver, type World, worldEngine } from "./replay-world.ts"

type Store = ReturnType<typeof memoryCacheStore>

const copyOf = (store: Store): Store => {
  const copy = memoryCacheStore()
  for (const [key, entry] of store.entries) copy.entries.set(key, entry)
  return copy
}
const dump = (store: Store): string => JSON.stringify([...store.entries])

interface RunOptions {
  readonly world?: World
  readonly model: E2EModel | undefined
  readonly store: Store
  readonly mode?: CacheMode
  readonly start?: "/" | "/alt"
  readonly check?: "pass" | "fail" | "none"
  readonly email?: string
  readonly appIdentity?: string
}

async function run(options: RunOptions) {
  const { factory } = worldEngine(options.world ?? {})
  const withMode: CacheOptions = {
    store: options.store,
    testId: "login",
    mode: options.mode ?? "read-write",
  }
  await using t = await e2e(app, {
    engine: factory,
    model: options.model,
    clock: virtualClock(),
    assertionTimeout: 50,
    cache:
      options.appIdentity === undefined
        ? withMode
        : { ...withMode, appIdentity: options.appIdentity },
  })
  await t.open(options.start ?? "/")
  const outcome = await t.agent
    .act("sign in as {email}", { params: { email: options.email ?? "ada@example.test" } })
    .catch((error: unknown) => {
      if (error instanceof Error) return error
      throw error
    })
  if (!(outcome instanceof Error)) {
    if (options.check === "pass") await expect(t.screen.getByRole("heading")).toBeVisible()
    if (options.check === "fail") {
      await expect(t.screen.getByText("never shown"))
        .toBeVisible()
        .catch(() => {})
    }
  }
  return { outcome, report: t.agent.report() }
}

const recorded = async (): Promise<Store> => {
  const store = memoryCacheStore()
  const model = solver()
  const { outcome } = await run({ model, store, check: "pass" })
  if (outcome instanceof Error) throw outcome
  check(outcome.source).toBe("model")
  check(model.requests).toHaveLength(3)
  return store
}

describe("acceptance on a fake engine", () => {
  test("run 1 records after a later check, run 2 replays with no model call", async () => {
    const store = memoryCacheStore()
    const first = await run({ model: solver(), store })
    check(store.entries.size).toBe(0)
    check(first.report).toMatchObject({ missed: 1, replayed: 0 })

    await run({ model: solver(), store, check: "pass" })
    check(store.entries.size).toBe(1)

    const never = refusing()
    const second = await run({ model: never, store, check: "pass" })
    check(second.outcome).toMatchObject({ source: "replay", modelCalls: 0 })
    check(never.calls).toBe(0)
    check(formatReport(second.report)).toBe(
      "Cache: 1 replayed - 0 handed off - 0 missed (0 model calls)",
    )
  })

  test("a renamed button hands off one step, repairs the entry, and the next run replays", async () => {
    const store = await recorded()
    const model = solver()
    const world = { button: "Log in" }
    const handed = await run({ world, model, store, check: "pass" })
    check(handed.outcome).toMatchObject({ source: "handoff" })
    const request = lastAct(model.requests)
    check(request?.handoff).toMatchObject({ reason: "target-not-found", performed: 1 })
    check(request?.history[0]).toMatchObject({ ok: true, action: { kind: "fill" } })
    check(model.requests.map((r) => r.kind)).toEqual(["act", "act"])
    check(handed.report).toMatchObject({ handedOff: 1, modelCalls: 2 })

    const never = refusing()
    const third = await run({ world, model: never, store, check: "pass" })
    check(third.outcome).toMatchObject({ source: "replay" })
    check(never.calls).toBe(0)
  })

  test("a target removed for good fails the step by name and deletes the entry", async () => {
    const store = await recorded()
    const model = { decide: () => ({ kind: "fail", reason: "no sign in button" }) }
    const { outcome } = await run({ world: { button: "Nope" }, model, store, check: "pass" })
    check(outcome).toBeInstanceOf(E2EError)
    check(outcome).toMatchObject({
      code: "STEP_FAILED",
      message: 'goal "sign in as ada@example.test" failed: no sign in button',
    })
    check(store.entries.size).toBe(0)
  })

  test("a new unique value replays and is typed again", async () => {
    const store = memoryCacheStore()
    const typed: string[] = []
    const make = (email: string) => {
      const { factory, log } = worldEngine({})
      return { factory, log, email }
    }
    for (const email of ["a-1@x.test", "b-2@x.test"]) {
      const { factory, log } = make(email)
      const model = typed.length === 0 ? solver() : refusing()
      await using t = await e2e(app, {
        engine: factory,
        model,
        clock: virtualClock(),
        cache: { store, testId: "unique", mode: "read-write" },
      })
      await t.open("/")
      await t.agent.act("sign in as {email}", { params: { email: unique(email) } })
      await expect(t.screen.getByRole("heading")).toBeVisible()
      typed.push(log.filter((entry) => entry.kind === "fill").map((entry) => entry.detail)[0] ?? "")
    }
    check(typed).toEqual(["a-1@x.test", "b-2@x.test"])
    check(store.entries.size).toBe(1)
    check(dump(store)).not.toContain("a-1@x.test")
  })

  test("a secret is typed on replay and is in no stored entry", async () => {
    const store = memoryCacheStore()
    const model = {
      decide: (request: ModelRequest) =>
        request.kind === "act" && request.history.length === 0
          ? { kind: "fill", target: { label: "Email" }, value: "{pw}" }
          : { kind: "done" },
    }
    const typed: string[] = []
    for (const m of [model, refusing()]) {
      const { factory, log } = worldEngine({})
      await using t = await e2e(app, {
        engine: factory,
        model: m,
        clock: virtualClock(),
        cache: { store, testId: "secret", mode: "read-write" },
      })
      await t.open("/")
      await t.agent.act("enter the password", { params: { pw: new Secret("pw", "hunter2") } })
      await expect(t.screen.getByRole("heading")).toBeVisible()
      typed.push(log.filter((entry) => entry.kind === "fill").map((entry) => entry.detail)[0] ?? "")
    }
    check(typed).toEqual(["hunter2", "hunter2"])
    check(dump(store)).not.toContain("hunter2")
  })
})

type Stop =
  | "none"
  | "route-mismatch"
  | "target-not-found"
  | "ambiguous"
  | "end-mismatch"
  | "action-uncertain"

const STOPS: Stop[] = [
  "none",
  "route-mismatch",
  "target-not-found",
  "ambiguous",
  "end-mismatch",
  "action-uncertain",
]

const SCENARIOS: Record<Stop, { world: World; start: "/" | "/alt" }> = {
  none: { world: {}, start: "/" },
  "route-mismatch": { world: {}, start: "/alt" },
  "target-not-found": { world: { button: "Log in" }, start: "/" },
  ambiguous: { world: { extraButtons: ["Sign in with SSO"] }, start: "/" },
  "end-mismatch": { world: { home: "Welcome" }, start: "/" },
  "action-uncertain": { world: { flaky: true }, start: "/" },
}

describe("every stop reason x cache mode x check outcome", () => {
  const modes: CacheMode[] = ["read-write", "read-only", "strict", "off"]
  const checks = ["pass", "fail", "none"] as const
  for (const stop of STOPS) {
    for (const mode of modes) {
      for (const outcomeOfCheck of checks) {
        test(`${stop} / ${mode} / check ${outcomeOfCheck}`, async () => {
          const original = await recorded()
          const store = copyOf(original)
          const before = dump(store)
          const model = solver()
          const { world, start } = SCENARIOS[stop]
          const { outcome, report } = await run({
            world,
            start,
            model,
            store,
            mode,
            check: outcomeOfCheck,
          })

          if (mode === "off") {
            check(outcome).toMatchObject({ source: "model" })
            check(dump(store)).toBe(before)
            return
          }
          if (stop === "none") {
            check(outcome).toMatchObject({ source: "replay", modelCalls: 0 })
            check(model.requests).toHaveLength(0)
            check(report.replayed).toBe(1)
          } else if (mode === "strict") {
            check(outcome).toBeInstanceOf(E2EError)
            check(outcome).toMatchObject({ code: "REPLAY_STALE" })
            check(outcome instanceof Error ? outcome.message : "").toContain(`(${stop})`)
            check(dump(store)).toBe(before)
            return
          } else {
            check(outcome).toMatchObject({ source: "handoff" })
            check(lastAct(model.requests)?.handoff?.reason).toBe(stop)
            check(report.handedOff).toBe(1)
          }

          if (mode !== "read-write" || outcomeOfCheck === "none") {
            check(dump(store)).toBe(before)
          } else if (outcomeOfCheck === "fail") {
            check(store.entries.size).toBe(0)
          } else if (stop === "none") {
            check(dump(store)).toBe(before)
          } else {
            const fresh = memoryCacheStore()
            await run({ world, start, model: solver(), store: fresh, check: "pass" })
            // The solver says `exact` only after one of its own taps fails; a hand-off never saw that failure.
            const plain = (text: string): string => text.replaceAll(',"exact":true', "")
            check(plain(dump(store))).toBe(plain(dump(fresh)))
          }
        })
      }
    }
  }
})

describe("modes and misses", () => {
  test("strict with no recording is REPLAY_MISSING and asks nobody", async () => {
    const model = refusing()
    const { outcome } = await run({ model, store: memoryCacheStore(), mode: "strict" })
    check(outcome).toMatchObject({ code: "REPLAY_MISSING" })
    check(model.calls).toBe(0)
  })

  test("a stale recording with no model is MODEL_MISSING, a good one needs none", async () => {
    const store = await recorded()
    const stale = await run({ world: { button: "Log in" }, model: undefined, store })
    check(stale.outcome).toMatchObject({ code: "MODEL_MISSING" })
    check(store.entries.size).toBe(1)
    const fine = await run({ model: undefined, store, mode: "read-only" })
    check(fine.outcome).toMatchObject({ source: "replay" })
  })

  test("a different app identity is a different recording", async () => {
    const store = memoryCacheStore()
    await run({ model: solver(), store, check: "pass", appIdentity: "v1" })
    const model = solver()
    const { outcome } = await run({ model, store, check: "pass", appIdentity: "v2" })
    check(outcome).toMatchObject({ source: "model" })
    check(store.entries.size).toBe(2)
  })
})
