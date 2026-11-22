import {
  ABSTRACT_ROLES,
  ARIA_ATTRIBUTES,
  ARIA_VALUES,
  CONCRETE_ROLES,
  IMPLICIT_ROLES,
  MODULE_ROLE_PREFIX,
  NATIVE_FOR_ROLE,
  ROLE_REQUIRED,
} from "./aria-data.ts"
import { distance } from "./edit-distance.ts"

export type A11yKind =
  | "invalid-role"
  | "abstract-role"
  | "unknown-aria"
  | "invalid-aria-value"
  | "missing-required"
  | "img-alt"
  | "tabindex"
  | "redundant-role"
  | "native-element"
  | "html-lang"

/** The two codes the kinds split into: markup assistive technology cannot read, and markup it reads worse. */
export type A11yCode = "NF-C062" | "NF-C063"

export const A11Y_KIND_CODE: Readonly<Record<A11yKind, A11yCode>> = Object.freeze({
  "invalid-role": "NF-C062",
  "abstract-role": "NF-C062",
  "unknown-aria": "NF-C062",
  "invalid-aria-value": "NF-C062",
  "missing-required": "NF-C062",
  "img-alt": "NF-C063",
  tabindex: "NF-C063",
  "redundant-role": "NF-C063",
  "native-element": "NF-C063",
  "html-lang": "NF-C063",
})

/** One accessibility finding in a file, from {@link a11yFindings}. */
export interface A11yFinding {
  readonly code: A11yCode
  readonly kind: A11yKind
  /** The start of the attribute at fault, or of the tag when the finding is an attribute that is missing. */
  readonly position: number
  /** The start of the element, where a `nifra-expect` comment is written above. */
  readonly expectAt: number
  readonly message: string
}

export type AttributeValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "other" }

/** One attribute an element spells out, by its lowercased name. */
export interface ElementAttribute {
  /** Where the attribute starts in the file. */
  readonly at: number
  readonly value: AttributeValue
}

/** Elements whose own state stands in for the `aria-*` attribute their role would otherwise need. */
const NATIVE_STATE = /^(?:input|select|textarea|option|meter|progress|h[1-6])$/

const closest = (word: string, among: Iterable<string>): string | undefined => {
  let best: string | undefined
  let bestDistance = 3
  for (const candidate of among) {
    const apart = distance(word, candidate)
    if (apart < bestDistance) {
      best = candidate
      bestDistance = apart
    }
  }
  return best
}

const didYouMean = (word: string, among: Iterable<string>): string => {
  const near = closest(word, among)
  return near === undefined ? "" : ` Did you mean "${near}"?`
}

/**
 * The findings for one element, from the attributes it spells out. The caller has already left out an
 * element it cannot read in full (a spread may supply or replace any attribute) and any tag that is not
 * a lowercase intrinsic element.
 */
export function judgeElement(
  tag: string,
  attributes: ReadonlyMap<string, ElementAttribute>,
  elementStart: number,
): readonly A11yFinding[] {
  const found: A11yFinding[] = []
  const report = (kind: A11yKind, position: number, message: string): void => {
    found.push({ code: A11Y_KIND_CODE[kind], kind, position, expectAt: elementStart, message })
  }
  const textOf = (name: string): string | undefined => {
    const value = attributes.get(name)?.value
    return value?.kind === "text" ? value.text : undefined
  }

  let role: string | undefined
  const written = attributes.get("role")
  const roleText = textOf("role")
  if (written !== undefined && roleText !== undefined) {
    const tokens = roleText.split(/\s+/).filter((token) => token !== "")
    const usable = tokens.find((token) => CONCRETE_ROLES.has(token))
    if (usable !== undefined) role = usable
    else if (tokens.length > 0 && !tokens.some((token) => MODULE_ROLE_PREFIX.test(token))) {
      const abstract = tokens.find((token) => ABSTRACT_ROLES.has(token))
      if (abstract !== undefined) {
        report(
          "abstract-role",
          written.at,
          `role="${abstract}" is an abstract role: it names a category, and a page may not use it. Use a concrete role such as "button", "checkbox" or "slider".`,
        )
      } else {
        const first = tokens[0] ?? ""
        report(
          "invalid-role",
          written.at,
          `role="${roleText}" names no ARIA role, so assistive technology ignores it.${didYouMean(first, CONCRETE_ROLES)}`,
        )
      }
    }
  }

  for (const [name, { at, value }] of attributes) {
    if (!name.startsWith("aria-")) continue
    if (!ARIA_ATTRIBUTES.has(name)) {
      report(
        "unknown-aria",
        at,
        `${name} is not an ARIA attribute, so assistive technology ignores it.${didYouMean(name.toLowerCase(), ARIA_ATTRIBUTES)}`,
      )
      continue
    }
    const allowed = ARIA_VALUES.get(name)
    if (allowed === undefined || value.kind !== "text") continue
    if (!allowed.includes(value.text.trim().toLowerCase()))
      report(
        "invalid-aria-value",
        at,
        `"${value.text}" is not a value of ${name}; it takes ${allowed.map((word) => `"${word}"`).join(", ")}.`,
      )
  }

  if (role !== undefined && written !== undefined) {
    const required = ROLE_REQUIRED.get(role) ?? []
    if (!NATIVE_STATE.test(tag)) {
      for (const name of required)
        if (!attributes.has(name))
          report("missing-required", written.at, `role="${role}" requires ${name}.`)
      if (role === "separator" && attributes.has("tabindex") && !attributes.has("aria-valuenow"))
        report(
          "missing-required",
          written.at,
          'a focusable role="separator" requires aria-valuenow.',
        )
    }
    const implicit = IMPLICIT_ROLES.get(tag)
    if (implicit === role && roleText?.trim() === role)
      report(
        "redundant-role",
        written.at,
        `<${tag}> already has the role "${role}"; the role attribute adds nothing.`,
      )
    else if (tag === "a" && attributes.has("href") && roleText?.trim() === "link")
      report(
        "redundant-role",
        written.at,
        '<a href> already has the role "link"; the role attribute adds nothing.',
      )
    const native = NATIVE_FOR_ROLE.get(role)
    if ((tag === "div" || tag === "span") && native !== undefined)
      report(
        "native-element",
        written.at,
        `<${tag} role="${role}"> has to rebuild what ${native} gives for free: keyboard operation, focus and the role itself.`,
      )
  }

  if (!attributes.has("alt")) {
    const type = textOf("type")
    const presentational = role === "none" || role === "presentation"
    if (
      (tag === "img" && !presentational) ||
      (tag === "input" && type === "image") ||
      (tag === "area" && attributes.has("href"))
    )
      report(
        "img-alt",
        elementStart,
        `<${tag}> has no alt attribute, so a screen reader reads out the file name. Describe the image, or write alt="" when it is decoration.`,
      )
  }

  const tabindex = textOf("tabindex")
  if (tabindex !== undefined && /^\s*\+?\d+\s*$/.test(tabindex) && Number(tabindex) > 0) {
    report(
      "tabindex",
      attributes.get("tabindex")?.at ?? elementStart,
      `tabindex="${tabindex.trim()}" pulls the element ahead of the page's own tab order. Use 0 to join the order or -1 to focus it from script.`,
    )
  }

  if (tag === "html" && !attributes.has("lang"))
    report(
      "html-lang",
      elementStart,
      "<html> has no lang attribute, so a screen reader picks its pronunciation from the reader's settings. Write lang=\"en\" or the page's language.",
    )
  return found
}
