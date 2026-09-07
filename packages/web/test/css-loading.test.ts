import { afterAll, beforeEach, expect, test } from "bun:test"
import { waitForStyles } from "../src/client.ts"
import { normalizeCssCodeSplit } from "../src/css-contract.ts"

class FakeLink extends EventTarget {
  readonly attrs = new Map<string, string>()
  readonly rel = "stylesheet"
  readonly href: string
  media = "print"
  sheet: StyleSheet | null = null
  removed = false

  constructor(href: string) {
    super()
    this.href = href
    this.attrs.set("href", href)
    this.attrs.set("data-nifra-css", "deferred")
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  remove(): void {
    this.removed = true
  }
}

class FakeDocument {
  links: FakeLink[] = []

  querySelectorAll<T>(_selector: string): T[] {
    return this.links as unknown as T[]
  }
}

const slot = globalThis as unknown as { document?: unknown }
const previousDocument = slot.document
const hadDocument = "document" in slot

let document: FakeDocument

beforeEach(() => {
  document = new FakeDocument()
  slot.document = document
})

afterAll(() => {
  if (hadDocument) slot.document = previousDocument
  else delete slot.document
})

const loadedSheet = {} as StyleSheet

test("waitForStyles promotes a loaded stylesheet and handles a cached sheet", async () => {
  const link = new FakeLink("/assets/app.css")
  document.links = [link]
  const waiting = waitForStyles({ timeoutMs: 100 })
  expect(link.media).toBe("print")
  link.sheet = loadedSheet
  link.dispatchEvent(new Event("load"))
  await waiting
  expect(link.media).toBe("all")
  expect(link.getAttribute("data-nifra-css-state")).toBe("loaded")

  const cached = new FakeLink("/assets/cached.css")
  cached.sheet = loadedSheet
  document.links = [cached]
  await waitForStyles({ timeoutMs: 100 })
  expect(cached.media).toBe("all")
  expect(cached.getAttribute("data-nifra-css-state")).toBe("loaded")
})

test("waitForStyles resolves CSS errors and never leaves media in print", async () => {
  const link = new FakeLink("/assets/missing.css")
  document.links = [link]
  const waiting = waitForStyles({ timeoutMs: 100 })
  link.dispatchEvent(new Event("error"))
  await waiting
  expect(link.media).toBe("all")
  expect(link.getAttribute("data-nifra-css-state")).toBe("error")
})

test("waitForStyles fails open after its bounded timeout", async () => {
  const link = new FakeLink("/assets/slow.css")
  document.links = [link]
  await waitForStyles({ timeoutMs: 1 })
  expect(link.media).toBe("all")
  expect(link.getAttribute("data-nifra-css-state")).toBe("timeout")
})

test("waitForStyles deduplicates framework links and ignores ordinary links", async () => {
  const first = new FakeLink("/assets/app.css")
  const duplicate = new FakeLink("/assets/app.css")
  const ordinary = new FakeLink("/assets/author.css")
  ordinary.attrs.delete("data-nifra-css")
  document.links = [first, duplicate, ordinary]
  const waiting = waitForStyles({ timeoutMs: 100 })
  const repeated = waitForStyles({ timeoutMs: 100 })
  expect(duplicate.removed).toBe(true)
  expect(ordinary.removed).toBe(false)
  first.dispatchEvent(new Event("load"))
  await Promise.all([waiting, repeated])
  expect(first.media).toBe("all")
  expect(ordinary.media).toBe("print")
})

test("waitForStyles rejects an invalid timeout before touching the document", () => {
  expect(() => waitForStyles({ timeoutMs: 0 })).toThrow(/finite positive number/)
  expect(() => waitForStyles({ timeoutMs: Number.NaN })).toThrow(/finite positive number/)
})

test("normalizeCssCodeSplit defaults and rejects non-boolean values", () => {
  expect(normalizeCssCodeSplit(undefined)).toBe(true)
  expect(normalizeCssCodeSplit(false)).toBe(false)
  expect(() => normalizeCssCodeSplit("false")).toThrow(/must be a boolean/)
})
