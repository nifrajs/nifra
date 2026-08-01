import { expect, test } from "bun:test"
import fc from "fast-check"
import {
  type HeadAttributeValue,
  type HeadTag,
  trustedHeadAttributes,
} from "../src/internal/head-attributes.ts"

const PROPERTY_OPTIONS = { numRuns: 500, seed: 0x4ead }
const META_ATTRIBUTES = new Set([
  "charset",
  "content",
  "http-equiv",
  "itemprop",
  "media",
  "name",
  "property",
  "scheme",
])
const LINK_ATTRIBUTES = new Set([
  "as",
  "blocking",
  "color",
  "crossorigin",
  "disabled",
  "fetchpriority",
  "href",
  "hreflang",
  "imagesizes",
  "imagesrcset",
  "integrity",
  "media",
  "nonce",
  "referrerpolicy",
  "rel",
  "sizes",
  "title",
  "type",
])
const DATA_ATTRIBUTE = /^data-[a-z0-9-]+$/

const attributeValue: fc.Arbitrary<HeadAttributeValue> = fc.oneof(
  fc.string({ unit: "binary", maxLength: 80 }),
  fc.boolean(),
  fc.constant(undefined),
)
const descriptor = fc.dictionary(fc.string({ unit: "binary", maxLength: 30 }), attributeValue, {
  maxKeys: 20,
})
const untypedDescriptor = fc.dictionary(
  fc.constantFrom(...META_ATTRIBUTES, ...LINK_ATTRIBUTES, "data-owner"),
  fc.oneof(
    attributeValue,
    fc.integer(),
    fc.bigInt(),
    fc.constant(null),
    fc.constant(Symbol("hostile")),
    fc.array(fc.integer(), { maxLength: 5 }),
    fc.dictionary(fc.string({ maxLength: 5 }), fc.integer(), { maxKeys: 3 }),
  ),
  { maxKeys: 20 },
)

function compactScheme(value: string): string {
  return [...value]
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 0x20 && code !== 0x7f
    })
    .join("")
    .toLowerCase()
}

test("property: trusted head attributes never emit handlers or off-contract names", () => {
  fc.assert(
    fc.property(fc.constantFrom<HeadTag>("meta", "link"), descriptor, (tag, attrs) => {
      let trusted: ReturnType<typeof trustedHeadAttributes> | undefined
      expect(() => {
        trusted = trustedHeadAttributes(tag, attrs)
      }).not.toThrow()
      if (trusted === null || trusted === undefined) return

      const allowed = tag === "meta" ? META_ATTRIBUTES : LINK_ATTRIBUTES
      for (const [name] of trusted) {
        expect(name).not.toMatch(/^on/i)
        expect(allowed.has(name) || DATA_ATTRIBUTE.test(name)).toBe(true)
      }
    }),
    PROPERTY_OPTIONS,
  )
})

test("property: untyped runtime values fail closed to strings or true", () => {
  fc.assert(
    fc.property(fc.constantFrom<HeadTag>("meta", "link"), untypedDescriptor, (tag, attrs) => {
      let trusted: ReturnType<typeof trustedHeadAttributes> | undefined
      expect(() => {
        trusted = trustedHeadAttributes(tag, attrs)
      }).not.toThrow()
      if (trusted === null || trusted === undefined) return
      for (const [, value] of trusted) {
        expect(value === true || typeof value === "string").toBe(true)
      }
    }),
    PROPERTY_OPTIONS,
  )
})

test("property: only HTTP(S) or relative link schemes survive href normalization", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 100 }), (href) => {
      const trusted = trustedHeadAttributes("link", { href })
      expect(trusted).not.toBeNull()
      const emitted = trusted?.find(([name]) => name === "href")?.[1]
      const compact = compactScheme(href)
      const scheme = /^([a-z][a-z0-9+.-]*):/.exec(compact)?.[1]
      if (scheme !== undefined && scheme !== "http" && scheme !== "https") {
        expect(emitted).toBeUndefined()
      }
    }),
    PROPERTY_OPTIONS,
  )
})

test("property: mixed-case non-network schemes with embedded controls are always rejected", () => {
  const controls = fc.constantFrom("\u0000", "\t", "\n", "\r", " ", "\u001f", "\u007f")
  const activeHref = fc
    .tuple(
      fc.constantFrom("javascript:", "vbscript:", "data:", "blob:", "file:", "mailto:"),
      fc.array(controls, { maxLength: 20 }),
    )
    .map(([scheme, noise]) => {
      const chars = [...scheme].map((char, index) =>
        index % 2 === 0 ? char.toUpperCase() : char.toLowerCase(),
      )
      for (const [index, control] of noise.entries()) {
        chars.splice((index * 3) % (chars.length + 1), 0, control)
      }
      return `${chars.join("")}alert(1)`
    })

  fc.assert(
    fc.property(activeHref, (href) => {
      expect(trustedHeadAttributes("link", { href })).toEqual([])
    }),
    PROPERTY_OPTIONS,
  )
})
