import { describe, expect, test } from "bun:test"
import { createFormatter, type Messages, type MessageTree } from "../src/index.ts"

const messages: Messages = {
  hello: "Hello {name}!",
  items: "{count, plural, =0 {no items} one {# item} other {# items}}",
  pronoun: "{gender, select, male {he} female {she} other {they}}",
  nested: "{count, plural, one {{name} has 1 message} other {{name} has # messages}}",
  combo:
    "{gender, select, male {Mr {name}} other {{name}}} sent {count, plural, one {a file} other {# files}}",
  empty: "just text",
}

describe("createFormatter - caching [AUDIT]", () => {
  test("reuses one instance per (locale, messages) so ASTs + Intl.* persist across calls", () => {
    const a = createFormatter("en", messages)
    expect(createFormatter("en", messages)).toBe(a) // same locale + catalog → reused (cheap per request)
    expect(createFormatter("fr", messages)).not.toBe(a) // different locale → distinct
    expect(createFormatter("en", { ...messages })).not.toBe(a) // different catalog object → distinct
  })
})

describe("createFormatter - t()", () => {
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

describe("createFormatter - n() / d()", () => {
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

describe("createFormatter - malformed messages fail soft", () => {
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

describe("createFormatter - selectordinal", () => {
  const ordinal = "{n, selectordinal, one {#st} two {#nd} few {#rd} =13 {thirteenth} other {#th}}"

  test("English ordinal categories, with exact cases first", () => {
    const f = createFormatter("en", { o: ordinal })
    const out = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map((n) => f.t("o", { n }))
    expect(out).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "thirteenth",
      "21st",
      "22nd",
      "23rd",
      "101st",
      "111th",
    ])
  })

  test("a locale without ordinal categories uses other", () => {
    const f = createFormatter("de", { o: "{n, selectordinal, one {x} other {#.}}" })
    expect(f.t("o", { n: 1 })).toBe("1.")
  })

  test("nests inside select and plural", () => {
    const f = createFormatter("en", {
      m: "{who, select, me {Your {n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} try} other {Try}}",
    })
    expect(f.t("m", { who: "me", n: 2 })).toBe("Your 2nd try")
  })
})

describe("createFormatter - # in the locale's number format", () => {
  test("grouping, decimals and the innermost plural's number", () => {
    const f = createFormatter("en", {
      items: "{count, plural, one {# item} other {# items}}",
      nested:
        "{a, plural, other {# outer {b, plural, other {# inner}} {k, select, x {# again} other {}}}}",
      text: "Issue #{id}",
    })
    expect(f.t("items", { count: 1000 })).toBe("1,000 items")
    expect(f.t("items", { count: 1.5 })).toBe("1.5 items")
    expect(f.t("nested", { a: 2000, b: 3, k: "x" })).toBe("2,000 outer 3 inner 2,000 again")
    expect(f.t("text", { id: 7 })).toBe("Issue #7") // outside a plural, # is text
  })

  test("memoized counts match Intl for every value, -0 and fractions included", () => {
    for (const locale of ["en", "pl", "ar", "cy"]) {
      const f = createFormatter(locale, {
        c: "{n, plural, zero {zero #} one {one #} two {two #} few {few #} many {many #} other {other #}}",
        o: "{n, selectordinal, zero {zero} one {one} two {two} few {few} many {many} other {other}}",
      })
      const cardinal = new Intl.PluralRules(locale)
      const ordinal = new Intl.PluralRules(locale, { type: "ordinal" })
      const number = new Intl.NumberFormat(locale)
      for (const n of [...Array.from({ length: 300 }, (_, i) => i), 1.5, -1, 1e21]) {
        for (let pass = 0; pass < 2; pass++) {
          expect(f.t("c", { n })).toBe(`${cardinal.select(n)} ${number.format(n)}`)
          expect(f.t("o", { n })).toBe(ordinal.select(n))
        }
      }
      expect(f.t("c", { n: -0 })).toBe(`${cardinal.select(-0)} ${number.format(-0)}`)
    }
  })

  test("follows the locale and the numberingSystem option", () => {
    const msg = { items: "{count, plural, one {# फ़ाइल} other {# फ़ाइलें}}" }
    expect(createFormatter("de", { n: "{c, plural, other {#}}" }).t("n", { c: 1234 })).toBe("1.234")
    const deva = createFormatter("hi", msg, { numberingSystem: "deva" })
    expect(deva.t("items", { count: 12345 })).toBe("१२,३४५ फ़ाइलें")
    expect(deva.n(42)).toBe("४२")
    expect(deva.n(42, { numberingSystem: "latn" })).toBe("42")
  })
})

describe("createFormatter - nested catalogs", () => {
  const en = {
    home: { title: "Welcome, {name}", cta: { label: "Start" } },
    faq: [
      { q: "What?", a: "This." },
      { q: "Why?", a: "{n, plural, one {# reason} other {# reasons}}" },
    ],
    tags: ["a", "b"],
    "flat.key": "flat wins",
    flat: { key: "nested loses" },
  }
  // A JSON catalog can hold a non-string by mistake; t() must not format it.
  const withNumber = { ...en, count: 3 } as unknown as MessageTree

  test("dotted keys reach nested strings and list items", () => {
    const f = createFormatter("en", en)
    expect(f.t("home.title", { name: "Ada" })).toBe("Welcome, Ada")
    expect(f.t("home.cta.label")).toBe("Start")
    expect(f.t("faq.1.a", { n: 2 })).toBe("2 reasons")
    expect(f.t("tags.0")).toBe("a")
  })

  test("a flat key containing a dot is found before the nested path", () => {
    expect(createFormatter("en", en).t("flat.key")).toBe("flat wins")
    expect(createFormatter("en", { a: { "b.c": "deep flat" } }).t("a.b.c")).toBe("deep flat")
  })

  test("t() on a block, a list or a non-string returns the key", () => {
    const f = createFormatter("en", withNumber)
    expect(f.t("home")).toBe("home")
    expect(f.t("faq")).toBe("faq")
    expect(f.t("count")).toBe("count")
    expect(f.t("home.title.extra")).toBe("home.title.extra")
  })

  test("get() returns the raw value from the first catalog that has it", () => {
    const fr = { home: { title: "Bienvenue, {name}" } }
    const f = createFormatter("fr", fr, { fallback: [en] })
    expect(f.get("home")).toEqual({ title: "Bienvenue, {name}" }) // no merge
    expect(f.get("faq")).toBe(en.faq)
    expect(f.get("faq.0.q")).toBe("What?")
    expect(f.get("nope")).toBeUndefined()
  })

  test("own properties only: prototype names are missing keys", () => {
    const f = createFormatter("en", { a: { b: "x" } })
    for (const key of ["constructor", "toString", "__proto__", "a.constructor", "a.b.length"]) {
      expect(f.t(key)).toBe(key)
    }
    expect(f.get("hasOwnProperty")).toBeUndefined()
  })

  test("an inherited Object.prototype member is never rendered as a var", () => {
    const f = createFormatter("en", {
      m: "[{constructor}][{toString}][{__proto__}][{name}]",
      s: "{constructor, select, other {fallback}}",
    })
    expect(f.t("m", { name: "Ada" })).toBe("[][][][Ada]")
    expect(f.t("m", { toString: "own" })).toBe("[][own][][]")
    expect(f.t("s")).toBe("fallback")
  })
})

describe("createFormatter - fallback and onMissing", () => {
  const en = { hi: "Hello", bye: "Bye", only: { en: "English only" } }
  const fr = { hi: "Bonjour" }
  const frCA = { hi: "Allô" }

  test("tries each fallback catalog in order", () => {
    const f = createFormatter("fr-CA", frCA, { fallback: [fr, en] })
    expect(f.t("hi")).toBe("Allô")
    expect(f.t("bye")).toBe("Bye")
    expect(f.t("only.en")).toBe("English only")
    expect(createFormatter("fr-CA", {}, { fallback: [fr, en] }).t("hi")).toBe("Bonjour")
  })

  test("formats a fallback message with the formatter's own locale", () => {
    const f = createFormatter("de", {}, { fallback: [{ n: "{c, plural, other {# x}}" }] })
    expect(f.t("n", { c: 1234 })).toBe("1.234 x")
  })

  test("onMissing fires once per key, after the whole chain misses", () => {
    const seen: string[] = []
    const onMissing = (key: string, locale: string) => seen.push(`${locale}:${key}`)
    const f = createFormatter("fr", fr, { fallback: [en], onMissing })
    expect(f.t("bye")).toBe("Bye")
    expect(f.t("nope")).toBe("nope")
    expect(f.t("nope")).toBe("nope")
    expect(f.get("gone")).toBeUndefined()
    expect(seen).toEqual(["fr:nope", "fr:gone"])
  })

  test("a throwing onMissing reports each key once", () => {
    const f = createFormatter(
      "en",
      {},
      {
        onMissing: (key) => {
          throw new Error(`missing ${key}`)
        },
      },
    )
    expect(() => f.t("a")).toThrow("missing a")
    expect(f.t("a")).toBe("a")
  })

  test("remembers a bounded number of reported keys, and keeps reporting past it", () => {
    let calls = 0
    const f = createFormatter("en", {}, { onMissing: () => calls++ })
    for (let i = 0; i < 1100; i++) f.t(`k${i}`)
    expect(calls).toBe(1100)
    for (let i = 0; i < 1024; i++) f.t(`k${i}`)
    expect(calls).toBe(1100)
    f.t("k1050")
    expect(calls).toBe(1101)
  })

  test("a key added to the catalog after a miss is found", () => {
    const catalog: Record<string, string> = {}
    const f = createFormatter("en", catalog)
    expect(f.t("late")).toBe("late")
    catalog.late = "now here"
    expect(f.t("late")).toBe("now here")
  })
})

describe("createFormatter - default options", () => {
  test("timeZone applies to d() unless a call sets its own", () => {
    const f = createFormatter("en", {}, { timeZone: "Asia/Kolkata" })
    const opts = { timeStyle: "short", hour12: false } as const
    expect(f.d(0, opts)).toBe("05:30")
    expect(f.d(0, { ...opts, timeZone: "UTC" })).toBe("00:00")
  })

  test("an invalid timeZone or locale throws at creation", () => {
    expect(() => createFormatter("en", {}, { timeZone: "Mars/Olympus" })).toThrow(RangeError)
    expect(() => createFormatter("not a locale!", {})).toThrow(RangeError)
  })

  test("malformed options throw before anything is cached", () => {
    expect(() =>
      createFormatter("en", {}, { fallback: {} as unknown as readonly Messages[] }),
    ).toThrow(/fallback must be an array/)
    expect(() => createFormatter("en", {}, { fallback: [null as unknown as Messages] })).toThrow(
      /fallback must be an array/,
    )
    expect(() => createFormatter("en", {}, { onMissing: "x" as unknown as () => void })).toThrow(
      /onMissing must be a function/,
    )
    expect(() => createFormatter("en", null as unknown as Messages)).toThrow(/catalog object/)
  })
})

describe("createFormatter - caching with options", () => {
  const catalog = { a: "A", n: "{c, plural, other {#}}" }
  const fallback = { b: "B" }
  const report = () => {}

  test("the same options reuse one instance; different options do not", () => {
    const a = createFormatter("en", catalog, { fallback: [fallback], onMissing: report })
    expect(createFormatter("en", catalog, { fallback: [fallback], onMissing: report })).toBe(a)
    expect(createFormatter("en", catalog, { fallback: [fallback] })).not.toBe(a)
    expect(createFormatter("en", catalog, { fallback: [{ b: "B" }], onMissing: report })).not.toBe(
      a,
    )
    expect(createFormatter("en", catalog, { timeZone: "UTC" })).not.toBe(
      createFormatter("en", catalog, { timeZone: "Asia/Tokyo" }),
    )
  })

  test("empty options are the plain formatter", () => {
    expect(createFormatter("en", catalog, {})).toBe(createFormatter("en", catalog))
    expect(createFormatter("en", catalog, { fallback: [] })).toBe(createFormatter("en", catalog))
  })

  test("a locale cannot collide with an options key", () => {
    const tokyo = createFormatter("en", catalog, { timeZone: "Asia/Tokyo" })
    const key = JSON.stringify(["en", "Asia/Tokyo", null, [], null])
    expect(() => createFormatter(key, catalog)).toThrow(RangeError)
    expect(tokyo.locale).toBe("en")
  })

  test("the formatters per catalog are bounded", () => {
    const own = { a: "A" }
    const first = createFormatter("en", own, { timeZone: "UTC" })
    const zones = Intl.supportedValuesOf("timeZone").slice(0, 130)
    for (const timeZone of zones) createFormatter("en", own, { timeZone })
    expect(createFormatter("en", own, { timeZone: "UTC" })).not.toBe(first)
  })

  test("the formatter is frozen and its methods work detached", () => {
    const f = createFormatter("en", catalog)
    expect(Object.isFrozen(f)).toBe(true)
    const { t, n } = f
    expect(t("a")).toBe("A")
    expect(n(1000)).toBe("1,000")
  })
})
