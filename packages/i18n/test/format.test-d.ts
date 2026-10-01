/**
 * Type-level tests for typed catalogs - verified by `tsc --noEmit`. Each `@ts-expect-error` FAILS the
 * build if the error it expects is absent. `Register` is augmented in an isolated program
 * (register-types.test.ts); here the catalog type is passed explicitly, so the root program stays
 * untyped for every other test.
 */
import {
  createFormatter,
  type MessageAt,
  type MessageKey,
  type MessagePath,
  type MessageTree,
  type PartialMessages,
} from "../src/index.ts"

const en = {
  home: { title: "Welcome, {name}", cta: { label: "Start" } },
  faq: [{ q: "What?", a: "This." }],
  tags: ["a", "b"],
  "flat.key": "flat",
  dotted: { "x.y": "deep flat" },
}
type En = typeof en

const assertType = <T>(_value: T): void => {}
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const isTrue = <T extends true>(_proof?: T): void => {}

// Keys `t()` takes: message leaves only, through blocks and lists.
isTrue<
  Equal<
    MessageKey<En>,
    | "home.title"
    | "home.cta.label"
    | `faq.${number}.q`
    | `faq.${number}.a`
    | `tags.${number}`
    | "flat.key"
    | "dotted.x.y"
  >
>()
// Paths `get()` takes add the blocks and lists themselves.
assertType<MessagePath<En>>("home")
assertType<MessagePath<En>>("home.cta")
assertType<MessagePath<En>>("faq")
assertType<MessagePath<En>>("faq.0")
// @ts-expect-error - not a key of the catalog
assertType<MessagePath<En>>("hom")

isTrue<Equal<MessageAt<En, "home.cta">, { label: string }>>()
isTrue<Equal<MessageAt<En, "faq">, { q: string; a: string }[]>>()
isTrue<Equal<MessageAt<En, "faq.0">, { q: string; a: string }>>()
isTrue<Equal<MessageAt<En, "flat.key">, string>>()

// An untyped catalog takes any string.
isTrue<Equal<MessageKey<MessageTree>, string>>()
isTrue<Equal<MessagePath<Record<string, string>>, string>>()

const t = createFormatter<En>("en", en)
t.t("home.title", { name: "Ada" })
t.t("faq.0.a")
// @ts-expect-error - a typo is a compile error
t.t("home.titel")
// @ts-expect-error - a block is not a message
t.t("home")
const faq = t.get("faq")
assertType<{ q: string; a: string }[] | undefined>(faq)
// @ts-expect-error - get() checks paths too
t.get("nope")

// Other locales are partial, with any string where the default has one.
const fr: PartialMessages<En> = { home: { title: "Bienvenue" } }
createFormatter<En>("fr", fr, { fallback: [en] })
// @ts-expect-error - a list where the default has a message
const bad: PartialMessages<En> = { home: { title: ["x"] } }
void bad
