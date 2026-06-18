import { describe, expect, test } from "bun:test"
import { island, islandState, mountIslands } from "../src/island.ts"
import { FakeElement, FakeHost, FakeRoot } from "./_fake-dom.ts"

let n = 0
const uniqueName = (): string => `island-test-${++n}`

describe("islands", () => {
  test("mounts a registered island: state seeds from data-island-state, bindings live", () => {
    const name = uniqueName()
    const text = new FakeElement({ "data-bind-text": "count" })
    const btn = new FakeElement({ "data-bind-on": "click:add" })
    const host = new FakeHost(
      { "data-island": name, "data-island-state": islandState({ count: 7 }) },
      [text, btn],
    )
    island(name, ({ state }) => {
      const count = state("count", 0)
      return { add: () => count.set((v) => (v as number) + 1) }
    })
    mountIslands(new FakeRoot([host]))
    expect(text.textContent).toBe("7") // seeded from the server state, not the fallback
    btn.dispatch("click")
    expect(text.textContent).toBe("8")
  })

  test("state(): fallback when the key is absent; same signal identity per key", () => {
    const name = uniqueName()
    const host = new FakeHost({ "data-island": name }, [])
    let first: unknown
    let second: unknown
    island(name, ({ state }) => {
      first = state("missing", "fallback")
      second = state("missing", "ignored-second-fallback")
      return undefined
    })
    mountIslands(new FakeRoot([host]))
    expect(first).toBe(second)
    expect((first as () => string)()).toBe("fallback")
  })

  test("mounting is idempotent; unregistered islands are skipped", () => {
    const name = uniqueName()
    let mounts = 0
    island(name, () => {
      mounts++
      return undefined
    })
    const host = new FakeHost({ "data-island": name }, [])
    const stranger = new FakeHost({ "data-island": "never-registered" }, [])
    const root = new FakeRoot([host, stranger])
    mountIslands(root)
    mountIslands(root)
    expect(mounts).toBe(1)
    expect(stranger.getAttribute("data-island-mounted")).toBeNull()
  })

  test("malformed state JSON mounts with fallbacks (static markup stays usable)", () => {
    const name = uniqueName()
    const text = new FakeElement({ "data-bind-text": "count" })
    const host = new FakeHost({ "data-island": name, "data-island-state": "{not json" }, [text])
    island(name, ({ state }) => {
      state("count", 42)
      return undefined
    })
    expect(() => mountIslands(new FakeRoot([host]))).not.toThrow()
    expect(text.textContent).toBe("42")
  })

  test("non-object state JSON (array/scalar) is rejected, fallbacks used", () => {
    const name = uniqueName()
    const text = new FakeElement({ "data-bind-text": "v" })
    const host = new FakeHost({ "data-island": name, "data-island-state": "[1,2,3]" }, [text])
    island(name, ({ state }) => {
      state("v", "safe")
      return undefined
    })
    mountIslands(new FakeRoot([host]))
    expect(text.textContent).toBe("safe")
  })

  test("islandState round-trips through an attribute-escaping renderer shape", () => {
    const state = { q: 'He said "hi" & left', n: 3 }
    const json = islandState(state)
    // What web-vanilla would do: escape for the attribute, browser unescapes on getAttribute.
    const escaped = json.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    const unescaped = escaped.replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    expect(JSON.parse(unescaped)).toEqual(state)
  })
})
