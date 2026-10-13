import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { COPY_CHUNKS_GLOBAL, type CopyMissing, copyRef, defineCopy } from "../src/copy.ts"
import { defineLocales } from "../src/index.ts"

const locales = defineLocales({
  default: "en",
  locales: { en: {}, fr: {}, "fr-CA": { tag: "fr-CA" }, ta: {}, ar: {} },
})
const REALM = Symbol.for("nifra.copy")
const dir = mkdtempSync(join(tmpdir(), "nifra-copy-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const reset = (): void => {
  Reflect.deleteProperty(globalThis, REALM)
  Reflect.deleteProperty(globalThis, COPY_CHUNKS_GLOBAL)
}
beforeEach(reset)
afterEach(reset)

/** Call a function with arguments its types refuse, to reach its run-time checks. */
const callUnchecked = (fn: (...args: never[]) => unknown, ...args: unknown[]): unknown =>
  Reflect.apply(fn, undefined, args)

interface Realm {
  prepare(path: string): Promise<void>
  pageLocales(path: string, lang: string | undefined): readonly string[]
}
const isRealm = (value: unknown): value is Realm =>
  typeof value === "object" && value !== null && "prepare" in value && "pageLocales" in value
const realmNow = (): Realm => {
  const value: unknown = Reflect.get(globalThis, REALM)
  if (!isRealm(value)) throw new Error("no copy realm")
  return value
}

let chunkCount = 0
/** Write a chunk module the way the client build does, returning its URL. Each in its own directory:
 * Bun caches a directory's listing once it resolves a module there. */
const chunk = (payload: unknown): string => {
  const file = join(mkdtempSync(join(dir, `chunk-${chunkCount++}-`)), "copy.js")
  writeFileSync(file, `export default JSON.parse(${JSON.stringify(JSON.stringify(payload))})\n`)
  return pathToFileURL(file).href
}

describe("source tables", () => {
  test("pick reads the locale's own value, then its chain", () => {
    const copy = defineCopy(locales)
    const title = copy({ en: "Bicycle", fr: "Vélo", ta: "மிதிவண்டி" })
    expect(copy.pick(title, "ta")).toBe("மிதிவண்டி")
    expect(copy.pick(title, "fr-CA")).toBe("Vélo")
    expect(copy.pick(title, "ar")).toBe("Bicycle")
    expect(copy.pick(copy({ en: ["a", "b"] }), "fr")).toEqual(["a", "b"])
  })

  test("a fallback fires onMissing once per table and locale, naming the locale used", () => {
    const missing: CopyMissing[] = []
    const copy = defineCopy(locales, { onMissing: (m) => missing.push(m) })
    const plain = copy({ en: "Bicycle", fr: "Vélo" })
    const named = copy.id("shop.title", { en: "Workshop" })
    for (let i = 0; i < 3; i++) {
      copy.pick(plain, "fr-CA")
      copy.pick(named, "ta")
    }
    copy.pick(plain, "fr")
    expect(missing).toEqual([
      { locale: "fr-CA", fallback: "fr", id: undefined },
      { locale: "ta", fallback: "en", id: "shop.title" },
    ])
  })

  test("format runs ICU in the locale's tag", () => {
    const copy = defineCopy(locales)
    const pedals = copy({
      en: "{n, plural, one {# pedal} other {# pedals}}",
      fr: "{n, plural, one {# pédale} other {# pédales}}",
    })
    expect(copy.format(pedals, "en", { n: 1 })).toBe("1 pedal")
    expect(copy.format(pedals, "fr", { n: 1000 })).toBe("1 000 pédales")
    expect(() => callUnchecked(copy.format, copy({ en: ["x"] }), "en")).toThrow("not a message")
  })

  test("a table without the default, with an undeclared locale, or a function value throws", () => {
    const copy = defineCopy(locales)
    expect(() => callUnchecked(copy, { fr: "x" })).toThrow('default locale "en"')
    expect(() => callUnchecked(copy, { en: "x", hn: "y" })).toThrow('"hn" is not a declared locale')
    expect(() => callUnchecked(copy, { en: () => "x" })).toThrow("is a function")
    expect(() => callUnchecked(copy, { en: 42 })).toThrow("not a message, or a list or block")
    expect(() => callUnchecked(copy, "x")).toThrow("an object of values by locale")
    expect(() => callUnchecked(copy.pick, {}, "en")).toThrow("not a copy table")
    expect(() => copy.id("", { en: "x" })).toThrow("non-empty")
    expect(() => callUnchecked(defineCopy, locales, { onMissing: "x" })).toThrow("onMissing")
    expect(() => callUnchecked(defineCopy, locales, { localeOf: "x" })).toThrow("localeOf")
  })

  test("load is a no-op where tables keep their values", async () => {
    const copy = defineCopy(locales)
    await copy.load()
    await copy.load("ta")
    expect(copy.pick(copy({ en: "x" }), "ta")).toBe("x")
  })
})

describe("chunk tables (production client build)", () => {
  test("a loaded locale's chunk answers, and its fallback marks fire onMissing", async () => {
    const missing: CopyMissing[] = []
    const copy = defineCopy(locales, { onMissing: (m) => missing.push(m) })
    Reflect.set(globalThis, COPY_CHUNKS_GLOBAL, {
      ta: chunk({ v: { a1: "மிதிவண்டி", b2: "Workshop" }, f: { b2: ["routes/index.tsx:4", "en"] } }),
    })
    await copy.load("ta")
    expect(copy.pick(copyRef("a1"), "ta")).toBe("மிதிவண்டி")
    expect(copy.pick(copyRef("b2"), "ta")).toBe("Workshop")
    copy.pick(copyRef("b2"), "ta")
    expect(missing).toEqual([{ locale: "ta", fallback: "en", id: "routes/index.tsx:4" }])
    expect(() => copy.pick(copyRef("zz"), "ta")).toThrow("not in the ta chunk")
  })

  test("load() reads the page's <html lang>, and the URL when localeOf is given", async () => {
    const copy = defineCopy(locales, { localeOf: () => "fr" })
    Reflect.set(globalThis, COPY_CHUNKS_GLOBAL, {
      ar: chunk({ v: { a1: "دراجة" } }),
      fr: chunk({ v: { a1: "Vélo" } }),
    })
    const restore = withDocument("ar-EG")
    try {
      await copy.load()
    } finally {
      restore()
    }
    expect(copy.pick(copyRef("a1"), "ar")).toBe("دراجة")
    expect(copy.pick(copyRef("a1"), "fr")).toBe("Vélo")
  })

  test("a client navigation loads the locale the next URL renders in", async () => {
    const copy = defineCopy(locales)
    Reflect.set(globalThis, COPY_CHUNKS_GLOBAL, {
      en: chunk({ v: { a1: "Bicycle" } }),
      ta: chunk({ v: { a1: "மிதிவண்டி" } }),
    })
    const realm = realmNow()
    await realm.prepare("http://app.test/ta/today")
    expect(copy.pick(copyRef("a1"), "ta")).toBe("மிதிவண்டி")
    await realm.prepare("http://app.test/about")
    expect(copy.pick(copyRef("a1"), "en")).toBe("Bicycle")
  })

  test("a page's locales are its URL's and its <html lang>'s, for the server's preload links", () => {
    defineCopy(locales)
    defineCopy(locales, { localeOf: (url) => (url.hostname === "fr.app.test" ? "fr" : undefined) })
    const realm = realmNow()
    expect(realm.pageLocales("/ta/today", "ta")).toEqual(["ta"])
    expect(realm.pageLocales("/ta/today", "en")).toEqual(["ta", "en"])
    expect(realm.pageLocales("/about", "ar-EG")).toEqual(["en", "ar"])
    expect(realm.pageLocales("http://fr.app.test/about", "fr-CA")).toEqual(["en", "fr-CA", "fr"])
  })

  test("a read before its chunk loads shows the closest loaded locale and loads it", async () => {
    const copy = defineCopy(locales)
    Reflect.set(globalThis, COPY_CHUNKS_GLOBAL, {
      fr: chunk({ v: { a1: "Vélo" } }),
      "fr-CA": chunk({ v: { a1: "Vélo (CA)" } }),
    })
    await copy.load("fr")
    const errors: unknown[] = []
    const error = console.error
    console.error = (...args: unknown[]) => void errors.push(args[0])
    try {
      expect(copy.pick(copyRef("a1"), "fr-CA")).toBe("Vélo")
      copy.pick(copyRef("a1"), "fr-CA")
    } finally {
      console.error = error
    }
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain("localeOf")
    await copy.load("fr-CA")
    expect(copy.pick(copyRef("a1"), "fr-CA")).toBe("Vélo (CA)")
  })

  test("a page that lists no chunks names the server entry fix", async () => {
    const copy = defineCopy(locales)
    expect(() => copy.pick(copyRef("a1"), "en")).toThrow("copyChunks")
    Reflect.set(globalThis, COPY_CHUNKS_GLOBAL, {})
    await expect(copy.load("ta")).rejects.toThrow("no copy chunk for locale")
    Reflect.set(globalThis, COPY_CHUNKS_GLOBAL, { ta: chunk({ nope: true }) })
    await expect(copy.load("ta")).rejects.toThrow("is not a copy chunk")
  })
})

function withDocument(lang: string): () => void {
  Reflect.set(globalThis, "document", { documentElement: { lang } })
  return () => Reflect.deleteProperty(globalThis, "document")
}
