import { describe, expect, test } from "bun:test"
import { bindScope, type IslandScope } from "../src/bind.ts"
import { type Signal, signal } from "../src/signals.ts"
import { FakeElement, FakeRoot } from "./_fake-dom.ts"

const scopeOf = (
  signals: Record<string, Signal<unknown>>,
  handlers: IslandScope["handlers"] = {},
): IslandScope => ({ signals, handlers })

describe("bindScope — the closed attribute set", () => {
  test("text: reflects the signal and updates", () => {
    const count = signal(2)
    const el = new FakeElement({ "data-bind-text": "count" })
    bindScope(new FakeRoot([el]), scopeOf({ count: count as Signal<unknown> }))
    expect(el.textContent).toBe("2")
    count.set(5)
    expect(el.textContent).toBe("5")
  })

  test("show: hidden mirrors falsiness", () => {
    const open = signal(false)
    const el = new FakeElement({ "data-bind-show": "open" })
    bindScope(new FakeRoot([el]), scopeOf({ open: open as Signal<unknown> }))
    expect(el.hidden).toBe(true)
    open.set(true)
    expect(el.hidden).toBe(false)
  })

  test("class: toggles pair list independently", () => {
    const a = signal(true)
    const b = signal(false)
    const el = new FakeElement({ "data-bind-class": "is-a:a, is-b:b" })
    bindScope(new FakeRoot([el]), scopeOf({ a: a as Signal<unknown>, b: b as Signal<unknown> }))
    expect([...el.classes]).toEqual(["is-a"])
    b.set(true)
    a.set(false)
    expect([...el.classes]).toEqual(["is-b"])
  })

  test("attr: sets, stringifies, and removes on false/null/undefined", () => {
    const expanded = signal<unknown>(true)
    const el = new FakeElement({ "data-bind-attr": "aria-expanded:expanded" })
    bindScope(new FakeRoot([el]), scopeOf({ expanded }))
    expect(el.getAttribute("aria-expanded")).toBe("true")
    expanded.set(3)
    expect(el.getAttribute("aria-expanded")).toBe("3")
    expanded.set(false)
    expect(el.getAttribute("aria-expanded")).toBeNull()
  })

  test("value: two-way — signal → input, input event → signal, no caret-jumping rewrite", () => {
    const q = signal("ada")
    const el = new FakeElement({ "data-bind-value": "q" })
    bindScope(new FakeRoot([el]), scopeOf({ q: q as Signal<unknown> }))
    expect(el.value).toBe("ada")
    el.value = "ada l"
    el.dispatch("input")
    expect(q()).toBe("ada l")
    q.set("typed")
    expect(el.value).toBe("typed")
  })

  test("on: pair list attaches handlers; events fire them", () => {
    const calls: string[] = []
    const el = new FakeElement({ "data-bind-on": "click:inc, keydown:nav" })
    bindScope(
      new FakeRoot([el]),
      scopeOf({}, { inc: () => calls.push("inc"), nav: () => calls.push("nav") }),
    )
    el.dispatch("click")
    el.dispatch("keydown")
    expect(calls).toEqual(["inc", "nav"])
  })

  test("unknown signal/handler names skip the binding (progressive enhancement, no throw)", () => {
    const el = new FakeElement({
      "data-bind-text": "missing",
      "data-bind-on": "click:nope",
    })
    el.textContent = "server-rendered"
    expect(() => bindScope(new FakeRoot([el]), scopeOf({}))).not.toThrow()
    expect(el.textContent).toBe("server-rendered") // static content untouched
  })

  test("disposers stop updates", () => {
    const count = signal(1)
    const el = new FakeElement({ "data-bind-text": "count" })
    const stops = bindScope(new FakeRoot([el]), scopeOf({ count: count as Signal<unknown> }))
    for (const stop of stops) stop()
    count.set(99)
    expect(el.textContent).toBe("1")
  })

  test("malformed pair entries are skipped, valid ones still bind", () => {
    const ok = signal(true)
    const el = new FakeElement({ "data-bind-class": ":broken,noColon,is-ok:ok" })
    bindScope(new FakeRoot([el]), scopeOf({ ok: ok as Signal<unknown> }))
    expect([...el.classes]).toEqual(["is-ok"])
  })
})
