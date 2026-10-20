import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  bindIsland,
  computed,
  defineIsland,
  effect,
  islandProps,
  mountIslands,
  resource,
  signal,
} from "../src/islands.ts"
import { FakeElement, FakeHost, FakeRoot } from "./_island-fake-dom.ts"

// The mount walks `querySelectorAll` and reads `dataset`; the fake DOM models exactly those.
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: FakeRoot implements the querySelectorAll the mount calls
const rootOf = (...hosts: FakeElement[]): ParentNode => new FakeRoot(hosts) as unknown as ParentNode

describe("bindIsland", () => {
  afterEach(() => {
    spyOn(console, "error").mockRestore()
  })

  test("state seeds from data-island-props; bindings and handlers are live", () => {
    const text = new FakeElement({ "data-bind-text": "count" })
    const btn = new FakeElement({ "data-bind-on": "click:add" })
    const host = new FakeHost(
      { "data-island": "counter", "data-island-props": islandProps({ count: 7 }) },
      [text, btn],
    )
    const counter = bindIsland(({ state }) => {
      const count = state("count", 0)
      return { add: () => count.set((v) => v + 1) }
    })
    mountIslands({ counter }, { root: rootOf(host) })
    expect(text.textContent).toBe("7")
    btn.dispatch("click")
    expect(text.textContent).toBe("8")
  })

  test("state(): fallback when absent or props are malformed; same signal per key", () => {
    const text = new FakeElement({ "data-bind-text": "v" })
    const host = new FakeHost({ "data-island": "i", "data-island-props": "[1,2" }, [text])
    let first: unknown
    let second: unknown
    const i = bindIsland(({ state }) => {
      first = state("v", "fallback")
      second = state("v", "ignored")
      return undefined
    })
    expect(() => mountIslands({ i }, { root: rootOf(host) })).not.toThrow()
    expect(first).toBe(second)
    expect(text.textContent).toBe("fallback")
  })

  test("state(): a key named like an Object.prototype member is a signal of its own", () => {
    const text = new FakeElement({ "data-bind-text": "__proto__" })
    const host = new FakeHost(
      { "data-island": "i", "data-island-props": '{"constructor":5,"__proto__":7}' },
      [text],
    )
    const seen: unknown[] = []
    const i = bindIsland(({ state }) => {
      for (const key of ["constructor", "__proto__", "toString"]) seen.push(state(key, 3)())
      return undefined
    })
    mountIslands({ i }, { root: rootOf(host) })
    expect(seen).toEqual([5, 7, 3])
    expect(text.textContent).toBe("7")
  })

  test("a binding belongs to its nearest island; a nested host is still its parent's markup", () => {
    const innerText = new FakeElement({ "data-bind-text": "count" })
    const inner = new FakeHost(
      {
        "data-island": "inner",
        "data-island-props": islandProps({ count: 1 }),
        "data-bind-show": "open",
      },
      [innerText],
    )
    const outerText = new FakeElement({ "data-bind-text": "count" })
    const bump = new FakeElement({ "data-bind-on": "click:bump" })
    const outer = new FakeHost(
      { "data-island": "outer", "data-island-props": islandProps({ count: 100, open: false }) },
      [outerText, bump, inner],
    )
    mountIslands(
      {
        outer: bindIsland(({ state }) => {
          const count = state("count", 0)
          state("open", true)
          return { bump: () => count.set(200) }
        }),
        inner: bindIsland(({ state }) => {
          state("count", 0)
          return undefined
        }),
      },
      { root: rootOf(outer, inner) },
    )
    bump.dispatch("click")
    expect(outerText.textContent).toBe("200")
    expect(innerText.textContent).toBe("1")
    expect(inner.hidden).toBe(true)
  })

  test("onDispose runs on unmount, and the island's handlers stop", () => {
    const btn = new FakeElement({ "data-bind-on": "click:save" })
    const host = new FakeHost({ "data-island": "i" }, [btn])
    let saves = 0
    let disposed = 0
    const i = bindIsland(({ onDispose }) => {
      onDispose(() => disposed++)
      return { save: () => saves++ }
    })
    const unmount = mountIslands({ i }, { root: rootOf(host) })
    btn.dispatch("click")
    unmount()
    btn.dispatch("click")
    expect(saves).toBe(1)
    expect(disposed).toBe(1)
  })

  test("onDispose registered after setup, from a handler, still runs on unmount", () => {
    const btn = new FakeElement({ "data-bind-on": "click:start" })
    const host = new FakeHost({ "data-island": "i" }, [btn])
    const timers: string[] = []
    const i = bindIsland(({ onDispose }) => ({
      start: () => {
        timers.push("started")
        onDispose(() => timers.push("cleared"))
      },
    }))
    const unmount = mountIslands({ i }, { root: rootOf(host) })
    btn.dispatch("click")
    unmount()
    expect(timers).toEqual(["started", "cleared"])
  })

  test("onDispose registered after unmount, once an awaited request settles, runs at once", async () => {
    const btn = new FakeElement({ "data-bind-on": "click:load" })
    const host = new FakeHost({ "data-island": "i" }, [btn])
    const timers: string[] = []
    let settled: Promise<void> | undefined
    const i = bindIsland(({ onDispose }) => ({
      load: () => {
        settled = Promise.resolve().then(() => {
          timers.push("started")
          onDispose(() => timers.push("cleared"))
        })
      },
    }))
    const unmount = mountIslands({ i }, { root: rootOf(host) })
    btn.dispatch("click")
    unmount()
    await settled
    expect(timers).toEqual(["started", "cleared"])
  })

  test("a setup that throws stops the effects and cleanups it started", () => {
    const error = spyOn(console, "error").mockImplementation(() => {})
    const n = signal(0)
    const runs: number[] = []
    let cleaned = 0
    const i = bindIsland(({ onDispose }) => {
      effect(() => {
        runs.push(n())
      })
      onDispose(() => cleaned++)
      throw new Error("setup")
    })
    mountIslands({ i }, { root: rootOf(new FakeHost({ "data-island": "i" }, [])) })
    n.set(1)
    expect(runs).toEqual([0])
    expect(cleaned).toBe(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  test("a binding that throws stops the bindings attached before it, and itself", () => {
    spyOn(console, "error").mockImplementation(() => {})
    const text = new FakeElement({ "data-bind-text": "n" })
    const bad = new FakeElement({ "data-bind-attr": "a b:n" })
    bad.setAttribute = () => {
      throw new Error("InvalidCharacterError")
    }
    let n: ReturnType<typeof signal<number>> | undefined
    const i = bindIsland(({ state }) => {
      n = state("n", 0)
    })
    mountIslands({ i }, { root: rootOf(new FakeHost({ "data-island": "i" }, [text, bad])) })
    expect(text.textContent).toBe("0")
    expect(() => n?.set(1)).not.toThrow()
    expect(text.textContent).toBe("0")
  })

  test("a cleanup that throws is logged and the other cleanups still run", () => {
    const error = spyOn(console, "error").mockImplementation(() => {})
    const ran: string[] = []
    const i = bindIsland(({ onDispose }) => {
      onDispose(() => ran.push("first"))
      onDispose(() => {
        throw new Error("cleanup")
      })
      onDispose(() => ran.push("last"))
    })
    const unmount = mountIslands({ i }, { root: rootOf(new FakeHost({ "data-island": "i" }, [])) })
    unmount()
    expect(ran).toEqual(["last", "first"])
    expect(error).toHaveBeenCalledTimes(1)
  })
})

describe("mountIslands", () => {
  test("an island inside data-island-ignore is never mounted", () => {
    let mounted = 0
    const host = new FakeHost({ "data-island": "i" }, [])
    const userContent = new FakeHost({ "data-island-ignore": "" }, [host])
    mountIslands({ i: () => void mounted++ }, { root: rootOf(userContent, host) })
    expect(mounted).toBe(0)
    expect(host.getAttribute("data-island-mounted")).toBeNull()
  })

  test("mounting is idempotent; disposing releases the host for remount", () => {
    let mounts = 0
    const host = new FakeHost({ "data-island": "i" }, [])
    const root = rootOf(host)
    const enhancers = { i: () => void mounts++ }
    const first = mountIslands(enhancers, { root })
    mountIslands(enhancers, { root })
    expect(mounts).toBe(1)
    first()
    expect(host.getAttribute("data-island-mounted")).toBeNull()
    mountIslands(enhancers, { root })
    expect(mounts).toBe(2)
  })

  test("enhancers with different props types mount from one map", () => {
    const seen: unknown[] = []
    const counter = defineIsland<{ start: number }>((_el, props) => void seen.push(props.start))
    const label = bindIsland<{ text: string }>(({ props }) => void seen.push(props?.text))
    const root = rootOf(
      new FakeHost(
        { "data-island": "counter", "data-island-props": islandProps({ start: 3 }) },
        [],
      ),
      new FakeHost(
        { "data-island": "label", "data-island-props": islandProps({ text: "hi" }) },
        [],
      ),
    )
    mountIslands({ counter, label }, { root })
    expect(seen).toEqual([3, "hi"])
  })

  test("an id that only names an Object.prototype member stays inert", () => {
    const host = new FakeHost({ "data-island": "constructor" }, [])
    expect(() => mountIslands({}, { root: rootOf(host) })).not.toThrow()
    expect(host.getAttribute("data-island-mounted")).toBeNull()
  })

  test("unmounting stops the computeds, effects and resources any enhancer created, across repeated mounts", () => {
    const shared = signal(0)
    let computes = 0
    let effects = 0
    let fetches = 0
    const make = () => {
      resource(shared, () => {
        fetches++
        return new Promise<never>(() => {})
      })
      const doubled = computed(() => {
        computes++
        return shared() * 2
      })
      effect(() => {
        effects++
        doubled()
      })
    }
    const enhancers = { a: defineIsland(make), b: bindIsland(make) }
    const mount = () =>
      mountIslands(enhancers, {
        root: rootOf(
          new FakeHost({ "data-island": "a" }, []),
          new FakeHost({ "data-island": "b" }, []),
        ),
      })
    for (let n = 0; n < 50; n++) mount()()
    computes = 0
    effects = 0
    fetches = 0
    shared.set(1)
    expect(computes).toBe(0)
    expect(effects).toBe(0)
    expect(fetches).toBe(0)
    const live = mount()
    computes = 0
    effects = 0
    fetches = 0
    shared.set(2)
    expect(computes).toBe(2)
    expect(effects).toBe(2)
    expect(fetches).toBe(2)
    live()
  })
})
