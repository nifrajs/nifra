import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { applyHead } from "../src/client.ts"

// `applyHead` applies `<html lang>`/`<html dir>` AUTHORITATIVELY, unlike `title` which it leaves alone
// when a route omits it. That asymmetry is the whole point and the reason these tests exist: the SSR
// shell defaults `lang` to "en" and omits `dir`, so a soft-nav that merely *skipped* absent values would
// strand the previous route's direction on the document. Navigating /ur → /en would leave `dir="rtl"` and
// lay the English page out right-to-left — in a state a hard reload never reproduces, which is the worst
// kind of bug to be handed.
//
// A hand-rolled DOM, matching the repo's idiom for client code (see packages/islets/test/_fake-dom.ts):
// no jsdom/happy-dom dependency, and it fakes exactly the surface `applyHead` touches.

class FakeElement {
  readonly attrs = new Map<string, string>()
  textContent = ""
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }
  remove(): void {
    document.head.children = document.head.children.filter((c) => c !== this)
  }
}

class FakeHead {
  children: FakeElement[] = []
  querySelectorAll(selector: string): FakeElement[] {
    // Only `[data-nifra]` is ever queried; anything else is a contract change worth failing on.
    if (selector !== "[data-nifra]") throw new Error(`unexpected selector: ${selector}`)
    return this.children.filter((c) => c.hasAttribute("data-nifra"))
  }
  appendChild(el: FakeElement): void {
    this.children.push(el)
  }
}

const document = {
  title: "",
  documentElement: new FakeElement(),
  head: new FakeHead(),
  createElement: (_tag: string) => new FakeElement(),
}

// Install the fake for THIS file only, and put back whatever was there. Assigning `globalThis.document`
// at module scope leaks: bun runs a directory's test files in one process, so the fake outlives this file
// and other suites start seeing a `document` that should not exist. That is not hypothetical - doing it
// at module scope here failed 6 tests in unrelated files.
const slot = globalThis as { document?: unknown }
const previousDocument = slot.document
const hadDocument = "document" in slot
beforeAll(() => {
  slot.document = document
})
afterAll(() => {
  if (hadDocument) slot.document = previousDocument
  else delete slot.document
})

afterEach(() => {
  document.documentElement.attrs.clear()
  document.head.children = []
  document.title = ""
})

test("a route's lang and dir reach <html>", () => {
  applyHead({ lang: "ur", dir: "rtl" })
  expect(document.documentElement.getAttribute("lang")).toBe("ur")
  expect(document.documentElement.getAttribute("dir")).toBe("rtl")
})

test("navigating away from an RTL route CLEARS dir (the /ur → /en drift)", () => {
  applyHead({ lang: "ur", dir: "rtl" })
  applyHead({}) // an English route that sets neither — exactly what a default `_layout` produces
  expect(document.documentElement.getAttribute("dir")).toBeNull()
  // And lang falls back to the same default the SSR shell emits, so a soft-nav and a hard load of the
  // same URL agree on `<html>`.
  expect(document.documentElement.getAttribute("lang")).toBe("en")
})

test("a route that sets only lang still clears a stale dir", () => {
  applyHead({ lang: "ar", dir: "rtl" })
  applyHead({ lang: "en" })
  expect(document.documentElement.getAttribute("lang")).toBe("en")
  expect(document.documentElement.hasAttribute("dir")).toBe(false)
})

test("dir=auto is applied verbatim (not treated as absent)", () => {
  applyHead({ dir: "auto" })
  expect(document.documentElement.getAttribute("dir")).toBe("auto")
})

test("title keeps its lax behaviour — absent means UNCHANGED, not reset", () => {
  // The deliberate asymmetry with lang/dir. A route without a `title` inherits whatever is on screen;
  // resetting it would blank the tab on every navigation to a title-less route.
  applyHead({ title: "Home" })
  applyHead({ lang: "fr" })
  expect(document.title).toBe("Home")
})

test("managed head tags are still replaced alongside the <html> attributes", () => {
  applyHead({ meta: [{ name: "description", content: "first" }] })
  expect(document.head.children).toHaveLength(1)
  applyHead({ lang: "de", meta: [{ name: "description", content: "second" }] })
  // Replaced, not accumulated — one description, and the <html> attrs applied in the same pass.
  expect(document.head.children).toHaveLength(1)
  expect(document.head.children[0]?.getAttribute("content")).toBe("second")
  expect(document.documentElement.getAttribute("lang")).toBe("de")
})
