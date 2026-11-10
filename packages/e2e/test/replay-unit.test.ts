import { describe, expect, test } from "bun:test"
import type { CacheEntry, RecordedAction } from "../src/cache.ts"
import { type FakeNode, fakeEngine } from "../src/fake.ts"
import { E2EError, type Engine } from "../src/index.ts"
import { type ReplayDeps, replayEntry } from "../src/replay.ts"
import { virtualClock } from "./helpers.ts"

const page: FakeNode[] = [
  { role: "textbox", name: "Email", label: "Email" },
  { role: "button", name: "Item", text: "Item" },
  { role: "button", name: "Item", text: "Item" },
  { role: "button", name: "Save", text: "Save" },
]

async function rig(
  options: { pages?: Record<string, readonly FakeNode[]>; wrap?: (engine: Engine) => Engine } = {},
) {
  const { factory, log } = fakeEngine({
    pages: options.pages ?? { "/": page, "/next": [{ role: "heading", name: "Next" }] },
    onAct: (node) => (node.name === "Save" ? "/next" : undefined),
  })
  const base = await factory({ baseUrl: "http://x", cookies: [], hydration: "off" })
  const engine = options.wrap?.(base) ?? base
  await engine.goto("http://x/")
  const clock = virtualClock()
  const navigated: string[] = []
  const deps: ReplayDeps = {
    engine,
    clock,
    pollInterval: 10,
    actionTimeout: 100,
    origin: "http://x",
    navigate: async (path) => {
      navigated.push(path)
      await engine.goto(`http://x${path}`)
    },
    observe: () => engine.snapshot(),
  }
  return { deps, log, navigated, clock }
}

const entryOf = (actions: RecordedAction[], end?: Partial<CacheEntry["end"]>): CacheEntry => ({
  version: 1,
  instruction: "x",
  startRoute: "/",
  actions,
  end: { route: "/", appeared: [], disappeared: [], ...end },
})

describe("replayEntry", () => {
  test("press, fill, nth and goto all replay with the current param values", async () => {
    const { deps, log, navigated } = await rig()
    const outcome = await replayEntry(
      deps,
      entryOf(
        [
          { kind: "fill", target: { label: "Email" }, matches: 1, value: "{email}" },
          { kind: "press", target: { label: "Email" }, matches: 1, key: "Enter" },
          { kind: "tap", target: { role: "button", name: "Item", nth: 1 }, matches: 2 },
          { kind: "goto", path: "/next?u={id}" },
        ],
        { route: "/next?u=abc" },
      ),
      { email: "ada@x.test", id: "abc" },
    )
    expect(outcome).toEqual({ ok: true })
    expect(log.map((entry) => `${entry.kind}:${entry.detail}`)).toEqual([
      "goto:/",
      "fill:ada@x.test",
      "press:Enter",
      "tap:",
      "goto:/next?u=abc",
    ])
    expect(navigated).toEqual(["/next?u=abc"])
  })

  test("a target that matches more or fewer than when recorded stops the replay", async () => {
    const more = await rig()
    const tooMany = await replayEntry(
      more.deps,
      entryOf([{ kind: "tap", target: { role: "button", name: "Item", nth: 0 }, matches: 1 }]),
      {},
    )
    expect(tooMany).toMatchObject({ ok: false, reason: "ambiguous", performed: [] })
    expect(more.clock.elapsed()).toBe(100)

    const gone = await rig()
    const none = await replayEntry(
      gone.deps,
      entryOf([{ kind: "tap", target: { role: "button", name: "Nothing", nth: 0 }, matches: 2 }]),
      {},
    )
    expect(none).toMatchObject({ ok: false, reason: "target-not-found" })
  })

  test("a target that shows up late is waited for", async () => {
    let calls = 0
    const { deps } = await rig({
      wrap: (engine) => ({
        ...engine,
        resolve: async (selector) => {
          calls += 1
          return calls < 3 ? [] : engine.resolve(selector)
        },
      }),
    })
    const outcome = await replayEntry(
      deps,
      entryOf([{ kind: "tap", target: { role: "button", name: "Item", nth: 1 }, matches: 2 }]),
      {},
    )
    expect(outcome).toEqual({ ok: true })
  })

  test("a goto the session refuses, or an unexpected engine error, is uncertain; others are not swallowed", async () => {
    const refused = await rig()
    const deps = {
      ...refused.deps,
      navigate: async () => {
        throw new TypeError("not same-origin")
      },
    }
    expect(await replayEntry(deps, entryOf([{ kind: "goto", path: "/x" }]), {})).toMatchObject({
      ok: false,
      reason: "action-uncertain",
      detail: "goto /x failed: not same-origin",
    })

    const crashed = await rig()
    const crash = {
      ...crashed.deps,
      navigate: async () => {
        throw new Error("browser died")
      },
    }
    await expect(replayEntry(crash, entryOf([{ kind: "goto", path: "/x" }]), {})).rejects.toThrow(
      "browser died",
    )

    const broken = await rig({
      wrap: (engine) => ({
        ...engine,
        act: async () => {
          throw new Error("browser died")
        },
      }),
    })
    await expect(
      replayEntry(
        broken.deps,
        entryOf([{ kind: "tap", target: { role: "button", name: "Save" }, matches: 1 }]),
        {},
      ),
    ).rejects.toThrow("browser died")

    const uncertain = await rig({
      wrap: (engine) => ({
        ...engine,
        act: async () => {
          throw new E2EError("NAVIGATION_FAILED", "unknown")
        },
      }),
    })
    expect(
      await replayEntry(
        uncertain.deps,
        entryOf([{ kind: "tap", target: { role: "button", name: "Save" }, matches: 1 }]),
        {},
      ),
    ).toMatchObject({ ok: false, reason: "action-uncertain", performed: [] })
  })

  test("the end is waited for, then judged on route and evidence", async () => {
    const early = await rig()
    const wrongRoute = await replayEntry(
      early.deps,
      entryOf([{ kind: "tap", target: { role: "button", name: "Save" }, matches: 1 }], {
        route: "/elsewhere",
      }),
      {},
    )
    expect(wrongRoute).toMatchObject({
      ok: false,
      reason: "end-mismatch",
      detail: "ended at /next, recorded /elsewhere",
    })
    const wrongEvidence = await rig()
    const missing = await replayEntry(
      wrongEvidence.deps,
      entryOf([{ kind: "tap", target: { role: "button", name: "Save" }, matches: 1 }], {
        route: "/next",
        appeared: ['- heading "Other"'],
      }),
      {},
    )
    expect(missing).toMatchObject({ ok: false, reason: "end-mismatch" })
  })

  test("a different start route stops before any action", async () => {
    const { deps, log } = await rig()
    const outcome = await replayEntry(
      deps,
      {
        ...entryOf([{ kind: "tap", target: { role: "button", name: "Save" }, matches: 1 }]),
        startRoute: "/other",
      },
      {},
    )
    expect(outcome).toMatchObject({ ok: false, reason: "route-mismatch" })
    expect(log.map((entry) => entry.kind)).toEqual(["goto"])
  })
})
