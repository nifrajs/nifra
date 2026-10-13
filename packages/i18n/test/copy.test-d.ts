/**
 * Type-level tests for copy tables - verified by `tsc --noEmit`. Each `@ts-expect-error` FAILS the
 * build if the error it expects is absent.
 */
import { type CopyTable, defineCopy } from "../src/copy.ts"
import { defineLocales } from "../src/index.ts"

const locales = defineLocales({
  default: "en",
  locales: { en: {}, hi: {}, ta: {}, ur: { tag: "ur-PK" } },
})
const copy = defineCopy(locales)

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const isTrue = <T extends true>(_proof?: T): void => {}

const title = copy({ en: "Bicycle", hi: "साइकिल", ur: "سائیکل" })
isTrue<Equal<typeof title, CopyTable<string>>>()
isTrue<Equal<ReturnType<typeof copy.pick<string>>, string>>()
const picked: string = copy.pick(title, "ta")

// Lists keep their length, blocks their keys; every other locale's value is shaped like the default's.
const faq = copy({ en: ["Brakes?", "Gears?"], hi: ["ब्रेक?", "गियर?"] })
isTrue<Equal<typeof faq, CopyTable<readonly [string, string]>>>()
const block = copy.id("shop.hero", {
  en: { title: "Saddle", cta: { label: "Pump" } },
  ta: { title: "சேணம்", cta: { label: "பம்ப்" } },
})
const hero: { readonly title: string; readonly cta: { readonly label: string } } = copy.pick(
  block,
  "hi",
)

// @ts-expect-error - "hn" is not a declared locale
copy({ en: "Bicycle", hn: "साइकिल" })
// @ts-expect-error - the default locale's value is required
copy({ hi: "साइकिल" })
// @ts-expect-error - a list translation must have the default's length
copy({ en: ["a", "b"], hi: ["क"] })
// @ts-expect-error - a block translation must have every key of the default's
copy({ en: { a: "x", b: "y" }, hi: { a: "क" } })
// @ts-expect-error - a message translation must be a message
copy({ en: "Bicycle", hi: ["साइकिल"] })
// @ts-expect-error - values are data; a message that takes values is ICU, read with format()
copy({ en: (n: number) => `${n} items` })
// @ts-expect-error - only a message table can be formatted
copy.format(faq, "en")
// @ts-expect-error - pick takes a declared locale
copy.pick(title, "fr")

copy.format(copy({ en: "{n, plural, one {# pedal} other {# pedals}}" }), "hi", { n: 2 })
void picked
void hero
