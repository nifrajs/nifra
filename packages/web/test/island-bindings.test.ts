import { describe, expect, spyOn, test } from "bun:test"
import { bindScope, type IslandScope } from "../src/internal/island-bindings.ts"
import { effect, type Signal, signal } from "../src/internal/island-signals.ts"
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
      "//other.example/image",
      "/\\other.example/image",
      "/\t/other.example/image",
    ]) {
      link.set(unsafe)
      expect(el.getAttribute("href")).toBeNull()
    }
  })

  test("attr: a URL attribute is never bound on an element that loads code or rebases the page", () => {
    const url = signal<unknown>("https://cdn.example/x.js")
    for (const [tagName, attr] of [
      ["SCRIPT", "src"],
      ["iframe", "src"],
      ["Object", "data"],
      ["EMBED", "src"],
      ["LINK", "href"],
      ["BASE", "href"],
    ] as const) {
      const el = Object.assign(new FakeElement({ "data-bind-attr": `${attr}:url,title:url` }), {
        tagName,
      })
      bindScope(new FakeRoot([el]), scopeOf({ url }))
      expect(el.getAttribute(attr)).toBeNull()
      // Only the URL attribute is refused: the element's other bindings still run.
      expect(el.getAttribute("title")).toBe("https://cdn.example/x.js")
    }
    for (const tagName of ["A", "IMG", "FORM", "SOURCE"]) {
      const el = Object.assign(new FakeElement({ "data-bind-attr": "href:url,src:url" }), {
        tagName,
      })
      bindScope(new FakeRoot([el]), scopeOf({ url }))
      expect(el.getAttribute("href")).toBe("https://cdn.example/x.js")
    }
  })

  test("attr: namespaced SVG animation elements are identified by local name", () => {
    const duration = signal<unknown>("1s")
    const el = Object.assign(new FakeElement({ "data-bind-attr": "dur:duration" }), {
      localName: "animate",
      tagName: "svg:animate",
    })
    bindScope(new FakeRoot([el]), scopeOf({ duration }))
    expect(el.getAttribute("dur")).toBeNull()
  })

  test("attr: no attribute of an SVG animation element is bound, so no link is animated to a script URL", () => {
    const url = signal<unknown>("javascript:alert(1)")
    for (const tagName of ["set", "animate", "animateMotion", "ANIMATETRANSFORM"]) {
      const el = Object.assign(
        new FakeElement({
          "data-bind-attr": "to:url,from:url,by:url,values:url,attributeName:url,dur:url",
        }),
        { tagName },
      )
      bindScope(new FakeRoot([el]), scopeOf({ url }))
      for (const refused of ["to", "from", "by", "values", "attributeName", "dur"])
        expect(el.getAttribute(refused)).toBeNull()
    }
    const other = Object.assign(new FakeElement({ "data-bind-attr": "to:url,values:url" }), {
      tagName: "div",
    })
    bindScope(new FakeRoot([other]), scopeOf({ url }))
    expect(other.getAttribute("to")).toBe("javascript:alert(1)")
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

describe("bindScope - first value against the server markup (development)", () => {
  const warnings = (run: () => void): string[] => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      run()
      return warn.mock.calls.map((call) => String(call[0]))
    } finally {
      warn.mockRestore()
    }
  }

  test("text: warns once when the server rendered another value, naming both", () => {
    const run = (): void => {
      const el = new FakeElement({ "data-bind-text": "drift_text" })
      el.textContent = "0"
      bindScope(new FakeRoot([el]), scopeOf({ drift_text: signal(5) }))
    }
    const first = warnings(run)
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('data-bind-text="drift_text"')
    expect(first[0]).toContain('server rendered "0"')
    expect(first[0]).toContain('starts with "5"')
    expect(warnings(run)).toEqual([])
  })

  test("text: matching text, surrounding whitespace and an empty slot stay silent", () => {
    const seen = warnings(() => {
      for (const server of ["5", "  5\n", ""]) {
        const el = new FakeElement({ "data-bind-text": "ok_text" })
        el.textContent = server
        bindScope(new FakeRoot([el]), scopeOf({ ok_text: signal(5) }))
      }
      const unrendered = new FakeElement({ "data-bind-text": "ok_text" })
      bindScope(new FakeRoot([unrendered]), scopeOf({ ok_text: signal(5) }))
    })
    expect(seen).toEqual([])
  })

  test("show: warns when the server's hidden state is not the signal's", () => {
    const seen = warnings(() => {
      const shown = new FakeElement({ "data-bind-show": "drift_show" })
      bindScope(new FakeRoot([shown]), scopeOf({ drift_show: signal(false) }))
      const hidden = new FakeElement({ "data-bind-show": "drift_show_2" })
      hidden.hidden = true
      bindScope(new FakeRoot([hidden]), scopeOf({ drift_show_2: signal(true) }))
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toContain(
      'server rendered "hidden=false" but the island starts with "hidden=true"',
    )
  })

  test("the check reads the signal untracked, so an effect the mount runs inside never reruns for it", () => {
    const n = signal("1")
    const shown = signal(true)
    let runs = 0
    const stop = effect(() => {
      runs++
      const el = new FakeElement({ "data-bind-text": "n", "data-bind-show": "shown" })
      el.textContent = "1"
      bindScope(new FakeRoot([el]), scopeOf({ n, shown }))
    })
    const seen = warnings(() => {
      n.set("2")
      shown.set(false)
    })
    stop()
    expect(runs).toBe(1)
    expect(seen).toEqual([])
  })

  test("text: a long server value is clipped in the warning", () => {
    const seen = warnings(() => {
      const el = new FakeElement({ "data-bind-text": "drift_long" })
      el.textContent = "x".repeat(5000)
      bindScope(new FakeRoot([el]), scopeOf({ drift_long: signal("y") }))
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.length).toBeLessThan(300)
    expect(seen[0]).toContain("...")
  })

  test("show: a matching hidden state stays silent", () => {
    const seen = warnings(() => {
      const el = new FakeElement({ "data-bind-show": "ok_show" })
      el.hidden = true
      bindScope(new FakeRoot([el]), scopeOf({ ok_show: signal(false) }))
    })
    expect(seen).toEqual([])
  })
})
