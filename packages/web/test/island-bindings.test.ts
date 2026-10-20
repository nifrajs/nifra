import { describe, expect, test } from "bun:test"
import { bindScope, type IslandScope } from "../src/internal/island-bindings.ts"
import { type Signal, signal } from "../src/internal/island-signals.ts"
import { FakeElement, FakeHost, FakeRoot } from "./_island-fake-dom.ts"

const scopeOf = <S extends Record<string, unknown>>(
  signals: { [K in keyof S]: Signal<S[K]> },
  handlers: IslandScope["handlers"] = {},
): IslandScope => ({
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the walker writes a signal only with values read from its own element, the way bindIsland's state() signals are written
  signals: signals as Record<string, Signal<unknown>>,
  handlers,
})

describe("bindScope - the closed attribute set", () => {
  test("text: reflects the signal and updates", () => {
    const count = signal(2)
    const el = new FakeElement({ "data-bind-text": "count" })
    bindScope(new FakeRoot([el]), scopeOf({ count: count }))
    expect(el.textContent).toBe("2")
    count.set(5)
    expect(el.textContent).toBe("5")
  })

  test("show: hidden mirrors falsiness", () => {
    const open = signal(false)
    const el = new FakeElement({ "data-bind-show": "open" })
    bindScope(new FakeRoot([el]), scopeOf({ open: open }))
    expect(el.hidden).toBe(true)
    open.set(true)
    expect(el.hidden).toBe(false)
  })

  test("class: toggles pair list independently", () => {
    const a = signal(true)
    const b = signal(false)
    const el = new FakeElement({ "data-bind-class": "is-a:a, is-b:b" })
    bindScope(new FakeRoot([el]), scopeOf({ a: a, b: b }))
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

  test("attr: never binds an event handler or srcdoc, whatever the markup asks for", () => {
    const query = signal<unknown>("document.title='PWNED'")
    const el = new FakeElement({
      "data-bind-attr": "ontoggle:query,ONCLICK:query,srcdoc:query,title:query",
    })
    bindScope(new FakeRoot([el]), scopeOf({ query }))
    expect(el.getAttribute("ontoggle")).toBeNull()
    expect(el.getAttribute("ONCLICK")).toBeNull()
    expect(el.getAttribute("srcdoc")).toBeNull()
    expect(el.getAttribute("title")).toBe("document.title='PWNED'")
  })

  test("attr: a URL attribute takes http(s), mailto, tel and relative URLs, never a script URL", () => {
    const link = signal<unknown>("https://example.com/a")
    const el = new FakeElement({ "data-bind-attr": "href:link" })
    bindScope(new FakeRoot([el]), scopeOf({ link }))
    expect(el.getAttribute("href")).toBe("https://example.com/a")
    for (const safe of ["/docs?x=1", "#top", "page.html", "mailto:a@b.c", "./a:b"]) {
      link.set(safe)
      expect(el.getAttribute("href")).toBe(safe)
    }
    for (const unsafe of [
      " javascript:alert(1)",
      "JavaScript:alert(1)",
      "java\tscript:x",
      "data:text/html,x",
      "vbscript:x",
    ]) {
      link.set(unsafe)
      expect(el.getAttribute("href")).toBeNull()
    }
  })

  test("value: two-way - signal → input, input event → signal, no caret-jumping rewrite", () => {
    const q = signal("ada")
    const el = new FakeElement({ "data-bind-value": "q" })
    bindScope(new FakeRoot([el]), scopeOf({ q: q }))
    expect(el.value).toBe("ada")
    el.value = "ada l"
    el.dispatch("input")
    expect(q()).toBe("ada l")
    q.set("typed")
    expect(el.value).toBe("typed")
  })

  test("value: a change event alone updates the signal, as a <select> sends", () => {
    const size = signal<unknown>("small")
    const el = new FakeElement({ "data-bind-value": "size" })
    bindScope(new FakeRoot([el]), scopeOf({ size }))
    el.value = "large"
    el.dispatch("change")
    expect(size()).toBe("large")
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

  test("a name an object inherits is unknown too", () => {
    const el = new FakeElement({
      "data-bind-text": "constructor",
      "data-bind-on": "click:toString",
    })
    el.textContent = "server-rendered"
    bindScope(new FakeRoot([el]), scopeOf({}))
    expect(el.textContent).toBe("server-rendered")
  })

  test("disposers stop updates", () => {
    const count = signal(1)
    const el = new FakeElement({ "data-bind-text": "count" })
    const stops = bindScope(new FakeRoot([el]), scopeOf({ count: count }))
    for (const stop of stops) stop()
    count.set(99)
    expect(el.textContent).toBe("1")
  })

  test("disposers remove value and handler listeners", () => {
    const value = signal<unknown>("initial")
    const input = new FakeElement({ "data-bind-value": "value" })
    const button = new FakeElement({ "data-bind-on": "click:save" })
    let saves = 0
    const stops = bindScope(
      new FakeRoot([input, button]),
      scopeOf({ value }, { save: () => saves++ }),
    )
    input.value = "live"
    input.dispatch("input")
    button.dispatch("click")
    expect(value()).toBe("live")
    expect(saves).toBe(1)
    for (const stop of stops) stop()
    input.value = "disposed"
    input.dispatch("input")
    button.dispatch("click")
    expect(value()).toBe("live")
    expect(saves).toBe(1)
  })

  test("malformed pair entries are skipped, valid ones still bind", () => {
    const ok = signal(true)
    const el = new FakeElement({ "data-bind-class": ":broken,noColon,is-ok:ok" })
    bindScope(new FakeRoot([el]), scopeOf({ ok: ok }))
    expect([...el.classes]).toEqual(["is-ok"])
  })
})

describe("bindScope - ignored subtrees", () => {
  test("nothing inside data-island-ignore binds a handler or a signal", () => {
    let saves = 0
    const label = signal<unknown>("secret")
    const own = new FakeElement({ "data-bind-on": "click:save" })
    const userButton = new FakeElement({ "data-bind-on": "click:save" })
    const userText = new FakeElement({ "data-bind-text": "label" })
    const ignoredItself = new FakeElement({
      "data-bind-on": "click:save",
      "data-island-ignore": "",
    })
    const host = new FakeHost({ "data-island": "comments" }, [
      own,
      new FakeHost({ "data-island-ignore": "" }, [userButton, userText]),
      ignoredItself,
    ])
    bindScope(host, scopeOf({ label }, { save: () => saves++ }))
    for (const el of [own, userButton, ignoredItself]) el.dispatch("click")
    expect(saves).toBe(1)
    expect(userText.textContent).toBeNull()
  })
})
