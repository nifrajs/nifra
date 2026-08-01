/**
 * The one trust boundary for route-owned `<meta>` and `<link>` attributes.
 *
 * Both SSR and soft navigation consume this normalized representation. Keeping policy here prevents
 * the two renderers from disagreeing about whether a descriptor is executable or otherwise unsafe.
 */

export type HeadTag = "meta" | "link"
export type HeadAttributeValue = string | boolean | undefined
export type TrustedHeadAttribute = readonly [name: string, value: string | true]

const SAFE_ATTR_NAME = /^[a-z][a-z0-9-]*$/
const DATA_ATTR_NAME = /^data-[a-z0-9-]+$/
const EVENT_ATTR_NAME = /^on/i

const META_ATTRIBUTES: ReadonlySet<string> = new Set([
  "charset",
  "content",
  "http-equiv",
  "itemprop",
  "media",
  "name",
  "property",
  "scheme",
])

const LINK_ATTRIBUTES: ReadonlySet<string> = new Set([
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

// Browsers ignore embedded ASCII whitespace/control characters while recognizing URL schemes. Remove
// them before checking so `java\nscript:` cannot evade the scheme policy. Relative and protocol-relative
// URLs are allowed; an explicit scheme must be HTTP(S). This rejects active and local schemes such as
// javascript:, vbscript:, data:, blob:, and file: before a descriptor reaches either renderer.
function hasDisallowedLinkScheme(value: string): boolean {
  let compact = ""
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code > 0x20 && code !== 0x7f) compact += char.toLowerCase()
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(compact)?.[1]
  return scheme !== undefined && scheme !== "http" && scheme !== "https"
}

/**
 * Normalize one descriptor. `null` means the entire element is unsafe (currently meta refresh).
 * Unknown attributes are dropped: future platform attributes must be reviewed and added explicitly.
 */
export function trustedHeadAttributes(
  tag: HeadTag,
  attrs: Readonly<object>,
): readonly TrustedHeadAttribute[] | null {
  if (typeof attrs !== "object" || attrs === null) return []
  let entries: Array<[string, unknown]>
  try {
    entries = Object.entries(attrs)
  } catch {
    // A route can cross this runtime boundary through untyped JavaScript or a cast. A hostile Proxy/getter
    // must not strand SSR or a soft navigation; reject the descriptor rather than partially trusting it.
    return []
  }

  if (tag === "meta") {
    for (const [rawName, value] of entries) {
      if (
        rawName.toLowerCase() === "http-equiv" &&
        typeof value === "string" &&
        value.trim().toLowerCase() === "refresh"
      )
        return null
    }
  }

  const allowed = tag === "meta" ? META_ATTRIBUTES : LINK_ATTRIBUTES
  const out: TrustedHeadAttribute[] = []
  for (const [rawName, value] of entries) {
    if (value === undefined || value === false) continue
    if (value !== true && typeof value !== "string") continue
    const name = rawName.toLowerCase()
    if (!SAFE_ATTR_NAME.test(name) || EVENT_ATTR_NAME.test(name)) continue
    if (!allowed.has(name) && !DATA_ATTR_NAME.test(name)) continue
    if (
      tag === "link" &&
      name === "href" &&
      typeof value === "string" &&
      hasDisallowedLinkScheme(value)
    )
      continue
    out.push([name, value === true ? true : value])
  }
  return out
}
