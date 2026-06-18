import { describe, expect, test } from "bun:test"
import { createFormatter, type Messages } from "../src/index.ts"

const messages: Messages = {
  hello: "Hello {name}!",
  items: "{count, plural, =0 {no items} one {# item} other {# items}}",
  pronoun: "{gender, select, male {he} female {she} other {they}}",
  nested: "{count, plural, one {{name} has 1 message} other {{name} has # messages}}",
  combo:
    "{gender, select, male {Mr {name}} other {{name}}} sent {count, plural, one {a file} other {# files}}",
  empty: "just text",
}

describe("createFormatter — caching [AUDIT]", () => {
  test("reuses one instance per (locale, messages) so ASTs + Intl.* persist across calls", () => {
    const a = createFormatter("en", messages)
    expect(createFormatter("en", messages)).toBe(a) // same locale + catalog → reused (cheap per request)
    expect(createFormatter("fr", messages)).not.toBe(a) // different locale → distinct
    expect(createFormatter("en", { ...messages })).not.toBe(a) // different catalog object → distinct
  })
})

describe("createFormatter — t()", () => {
  const f = createFormatter("en", messages)

  test("interpolation", () => {
    expect(f.t("hello", { name: "Ada" })).toBe("Hello Ada!")
    expect(f.t("empty")).toBe("just text")
  })

  test("a missing var renders empty; a missing key returns the key", () => {
    expect(f.t("hello", {})).toBe("Hello !")
    expect(f.t("does_not_exist")).toBe("does_not_exist")
  })

  test("plural with exact (=0), one, other + # substitution", () => {
    expect(f.t("items", { count: 0 })).toBe("no items") // =0 exact case wins over plural category
    expect(f.t("items", { count: 1 })).toBe("1 item")
    expect(f.t("items", { count: 5 })).toBe("5 items")
  })

  test("select", () => {
    expect(f.t("pronoun", { gender: "male" })).toBe("he")
    expect(f.t("pronoun", { gender: "female" })).toBe("she")
    expect(f.t("pronoun", { gender: "nonbinary" })).toBe("they") // → other
  })

  test("nested interpolation inside a plural case", () => {
    expect(f.t("nested", { count: 1, name: "Ada" })).toBe("Ada has 1 message")
    expect(f.t("nested", { count: 3, name: "Ada" })).toBe("Ada has 3 messages")
  })

  test("select + plural composed", () => {
    expect(f.t("combo", { gender: "male", name: "Lee", count: 1 })).toBe("Mr Lee sent a file")
    expect(f.t("combo", { gender: "x", name: "Lee", count: 4 })).toBe("Lee sent 4 files")
  })

  test("the parsed AST is cached (second call works the same)", () => {
    expect(f.t("items", { count: 2 })).toBe("2 items")
    expect(f.t("items", { count: 2 })).toBe("2 items")
  })

  test("locale-correct plural categories (Polish: few vs many)", () => {
    const pl = createFormatter("pl", {
      n: "{c, plural, one {plik} few {pliki} many {plików} other {x}}",
    })
    expect(pl.t("n", { c: 1 })).toBe("plik")
    expect(pl.t("n", { c: 2 })).toBe("pliki") // 2-4 → few in pl
    expect(pl.t("n", { c: 5 })).toBe("plików") // 5+ → many in pl
  })
})

describe("createFormatter — n() / d()", () => {
  test("number formatting per locale (memoized)", () => {
    const de = createFormatter("de-DE", {})
    expect(de.n(1234.5)).toBe("1.234,5")
    expect(de.n(0.42, { style: "percent" })).toMatch(/^42\s*%$/) // de uses a narrow no-break space
    expect(de.n(1234.5)).toBe("1.234,5") // cache hit, same result
  })

  test("date formatting per locale (memoized)", () => {
    const f = createFormatter("en", {})
    expect(f.d(0, { dateStyle: "medium", timeZone: "UTC" })).toContain("1970")
    expect(f.d(new Date(0), { dateStyle: "medium", timeZone: "UTC" })).toContain("Jan")
  })
})

describe("createFormatter — malformed messages fail soft", () => {
  test("unterminated / bad placeholders return the raw message instead of throwing", () => {
    const bad = [
      "{unterminated",
      "{}",
      "{n, frobnicate, a {b}}",
      "{n plural}",
      "{n, plural a {b}}",
      "{n, plural, one b}",
      "{n, plural, one {a",
      "hello } trailing",
    ]
    for (const raw of bad) {
      const f = createFormatter("en", { x: raw })
      expect(f.t("x")).toBe(raw)
      expect(f.t("x")).toBe(raw) // cached fallback, no repeated parser throw on hot paths
    }
  })
})
