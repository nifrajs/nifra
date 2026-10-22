/**
 * The tagged-template HTML engine - `html` builds an escaped-by-construction {@link Template}.
 *
 * Security model (the part that matters): an interpolated value is written for the place it lands,
 * which `html` reads from the template's static text once per call site.
 *
 * - Text, or a quoted attribute value: HTML-escaped (`& < > " '`). A nested template inside an
 *   attribute value is escaped as text too.
 * - An unquoted attribute value: quoted for you, then escaped, so a space cannot start another
 *   attribute.
 * - A URL attribute (`href`, `src`, `action`, ...) whose value an interpolation begins: a
 *   `javascript:` or `vbscript:` URL becomes `about:invalid`.
 * - A tag name, the body of `<script>` or `<style>`, and an event handler or `srcdoc` value: no
 *   escaping makes a string safe there, so a string or a nested template throws. An attribute name
 *   takes only a plain valueless name, such as `checked`. Numbers, booleans and an explicit
 *   {@link raw} are allowed in all of them.
 *
 * The ONLY ways to emit unescaped markup are a nested `html` template in text and an explicit
 * {@link raw} wrapper, which is the audit-greppable opt-out.
 */

import { type SlotRange, templateSlots } from "./template-slots.ts"

/** Branded wrapper marking a string as pre-trusted markup. Construct only via {@link raw}. */
export class RawHtml {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
}

/**
 * Mark a string as trusted, pre-escaped markup - it is emitted verbatim. The deliberate escape
 * hatch (CMS-sanitized HTML, pre-rendered markdown): every call site is greppable, exactly like
 * React's dangerouslySetInnerHTML, without the JSX.
 */
export function raw(trusted: string): RawHtml {
  return new RawHtml(trusted)
}

const ESCAPE_RE = /[&<>"']/

const escapeHtml = (s: string): string => {
  // Fast path: most text has nothing to escape - one regex probe, zero allocation.
  if (!ESCAPE_RE.test(s)) return s
  let out = ""
  let last = 0
  for (let i = 0; i < s.length; i++) {
    let entity: string
    switch (s.charCodeAt(i)) {
      case 38:
        entity = "&amp;"
        break
      case 60:
        entity = "&lt;"
        break
      case 62:
        entity = "&gt;"
        break
      case 34:
        entity = "&quot;"
        break
      case 39:
        entity = "&#39;"
        break
      default:
        continue
    }
    out += s.slice(last, i) + entity
    last = i + 1
  }
  return out + s.slice(last)
}

/** A rendered HTML fragment - what `html` returns and components produce. Stringified once. */
export class Template {
  /** The final markup. Built eagerly at tag time (interpolations are already values by then). */
  readonly html: string
  constructor(htmlString: string) {
    this.html = htmlString
  }
  toString(): string {
    return this.html
  }
}

/** What an interpolation may be: escaped primitives, nested templates/raw, arrays of the same.
 * `null`/`undefined`/`false` render as nothing (conditional rendering: `cond && html\`…\``). */
export type HtmlValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Template
  | RawHtml
  | ReadonlyArray<HtmlValue>

// Where an interpolation lands.
const TEXT = 0
const ATTR = 1
const URL_VALUE = 2
const CODE = 3
const TAG = 4
const NAME = 5

interface Place {
  readonly kind: number
  /** A URL value an interpolation begins: the static characters before it, or -1 when an earlier
   * interpolation began the value. */
  readonly lead: number
  /** An attribute name: the static text after it gives the attribute a value. */
  readonly valued: boolean
}

interface Hole extends Place {
  /** The static text between the previous interpolation and this one, quotes added. */
  readonly before: string
  /** The static text between this interpolation and the next, quotes added. */
  readonly after: string
}

interface CallSite {
  readonly head: string
  readonly holes: readonly Hole[]
}

// Attributes a browser reads as a URL it may navigate to or load.
const URL_ATTRIBUTES = new Set([
  "action",
  "background",
  "cite",
  "codebase",
  "data",
  "formaction",
  "href",
  "longdesc",
  "manifest",
  "poster",
  "src",
  "xlink:href",
])
const RAW_TEXT = new Set(["iframe", "noembed", "noframes", "noscript", "textarea", "title", "xmp"])
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_.:-]*$/
const VALUED = /^[\t\n\f\r ]*=/

const isSpace = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f"
const isAlpha = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z")
const isBlank = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x20) return false
  return true
}

const valueKindOf = (name: string, dynamic: boolean): number =>
  dynamic || name.startsWith("on") || name === "srcdoc"
    ? CODE
    : URL_ATTRIBUTES.has(name)
      ? URL_VALUE
      : ATTR

// Tokenizer states, a subset of the HTML spec's enough to place every interpolation.
const DATA = 0
const TAG_OPEN = 1
const END_TAG_OPEN = 2
const TAG_NAME = 3
const BEFORE_NAME = 4
const ATTR_NAME = 5
const AFTER_NAME = 6
const BEFORE_VALUE = 7
const QUOTED = 8
const UNQUOTED = 9
const AFTER_QUOTED = 10
const SELF_CLOSING = 11
const COMMENT = 12
const BOGUS = 13
const RAW = 14
const PLAINTEXT = 15

/**
 * Place every interpolation of one call site, and quote each unquoted attribute value an
 * interpolation sits in: the opening quote where the value starts, the closing one where it ends.
 */
function analyze(strings: readonly string[]): CallSite {
  const statics: string[] = []
  const places: Place[] = []
  let state = DATA
  let endTag = false
  let tagName = ""
  let tagDynamic = false
  let attrName = ""
  let attrDynamic = false
  let valueKind = ATTR
  let valueText = ""
  let valueHoles = 0
  let quote = '"'
  // An unquoted value being quoted for the caller: it closes where the unquoted value would end.
  let synthetic = false
  let unquotedAt = { part: 0, offset: 0 }
  let rawEnd = ""
  let rawCode = false

  const emitTag = (): void => {
    const name = tagName.toLowerCase()
    if (endTag || tagDynamic) state = DATA
    else if (name === "script" || name === "style") {
      state = RAW
      rawEnd = name
      rawCode = true
    } else if (RAW_TEXT.has(name)) {
      state = RAW
      rawEnd = name
      rawCode = false
    } else state = name === "plaintext" ? PLAINTEXT : DATA
  }

  for (const [part, s] of strings.entries()) {
    let cur = ""
    let j = 0
    while (j < s.length) {
      const c = s.charAt(j)
      switch (state) {
        case DATA:
          if (c === "<") state = TAG_OPEN
          break
        case TAG_OPEN:
          if (isAlpha(c)) {
            state = TAG_NAME
            endTag = false
            tagDynamic = false
            tagName = c
          } else if (c === "/") state = END_TAG_OPEN
          else if (c === "!" && s.startsWith("--", j + 1)) {
            cur += "!--"
            j += 3
            state = COMMENT
            if (s[j] === ">") {
              cur += ">"
              j++
              state = DATA
            } else if (s.startsWith("->", j)) {
              cur += "->"
              j += 2
              state = DATA
            }
            continue
          } else if (c === "!" || c === "?") state = BOGUS
          else {
            state = DATA
            continue
          }
          break
        case END_TAG_OPEN:
          if (isAlpha(c)) {
            state = TAG_NAME
            endTag = true
            tagDynamic = false
            tagName = c
          } else state = c === ">" ? DATA : BOGUS
          break
        case TAG_NAME:
          if (isSpace(c)) state = BEFORE_NAME
          else if (c === "/") state = SELF_CLOSING
          else if (c === ">") emitTag()
          else tagName += c
          break
        case BEFORE_NAME:
          if (c === "/") state = SELF_CLOSING
          else if (c === ">") emitTag()
          else if (!isSpace(c)) {
            state = ATTR_NAME
            attrName = c.toLowerCase()
            attrDynamic = false
          }
          break
        case ATTR_NAME:
          if (isSpace(c)) state = AFTER_NAME
          else if (c === "/") state = SELF_CLOSING
          else if (c === ">") emitTag()
          else if (c === "=") {
            state = BEFORE_VALUE
            valueKind = valueKindOf(attrName, attrDynamic)
          } else attrName += c.toLowerCase()
          break
        case AFTER_NAME:
          if (c === "/") state = SELF_CLOSING
          else if (c === "=") {
            state = BEFORE_VALUE
            valueKind = valueKindOf(attrName, attrDynamic)
          } else if (c === ">") emitTag()
          else if (!isSpace(c)) {
            state = ATTR_NAME
            attrName = c.toLowerCase()
            attrDynamic = false
          }
          break
        case BEFORE_VALUE:
          valueText = ""
          valueHoles = 0
          if (c === '"' || c === "'") {
            state = QUOTED
            quote = c
            synthetic = false
          } else if (c === ">") emitTag()
          else if (!isSpace(c)) {
            state = UNQUOTED
            unquotedAt = { part, offset: cur.length }
            valueText = c
          }
          break
        case QUOTED:
          if (synthetic) {
            if (isSpace(c) || c === ">") {
              cur += '"'
              synthetic = false
              state = BEFORE_NAME
              continue
            }
            if (c === '"') {
              cur += "&quot;"
              j++
              continue
            }
            valueText += c
          } else if (c === quote) state = AFTER_QUOTED
          else valueText += c
          break
        case UNQUOTED:
          if (isSpace(c)) state = BEFORE_NAME
          else if (c === ">") emitTag()
          else valueText += c
          break
        case AFTER_QUOTED:
          if (c === "/") state = SELF_CLOSING
          else if (c === ">") emitTag()
          else {
            state = BEFORE_NAME
            if (!isSpace(c)) continue
          }
          break
        case SELF_CLOSING:
          if (c === ">") emitTag()
          else {
            state = BEFORE_NAME
            continue
          }
          break
        case COMMENT:
          if (c === "-" && (s.startsWith("->", j + 1) || s.startsWith("-!>", j + 1))) {
            const close = s.startsWith("->", j + 1) ? "-->" : "--!>"
            cur += close
            j += close.length
            state = DATA
            continue
          }
          break
        case BOGUS:
          if (c === ">") state = DATA
          break
        case RAW:
          if (
            c === "<" &&
            s[j + 1] === "/" &&
            s.slice(j + 2, j + 2 + rawEnd.length).toLowerCase() === rawEnd &&
            (j + 2 + rawEnd.length === s.length ||
              /[\t\n\f\r />]/.test(s.charAt(j + 2 + rawEnd.length)))
          ) {
            cur += "</"
            j += 2
            state = END_TAG_OPEN
            continue
          }
          break
      }
      cur += c
      j++
    }

    if (part === strings.length - 1) {
      if (state === QUOTED && synthetic) cur += '"'
      statics.push(cur)
      break
    }

    // The interpolation that follows this static text.
    let hole: Place
    switch (state) {
      case TAG_OPEN:
      case END_TAG_OPEN:
      case TAG_NAME:
        hole = { kind: TAG, lead: 0, valued: false }
        if (state !== TAG_NAME) endTag = state === END_TAG_OPEN
        state = TAG_NAME
        tagDynamic = true
        break
      case BEFORE_NAME:
      case ATTR_NAME:
      case AFTER_NAME:
      case AFTER_QUOTED:
      case SELF_CLOSING:
        if (state === ATTR_NAME && (attrName.startsWith("data-") || attrName.startsWith("aria-"))) {
          // No name past these prefixes runs code or loads a URL, so the value stays plain text.
          hole = { kind: NAME, lead: 0, valued: false }
          break
        }
        hole = { kind: NAME, lead: 0, valued: VALUED.test(strings[part + 1] ?? "") }
        if (state !== ATTR_NAME) attrName = ""
        state = ATTR_NAME
        attrDynamic = true
        break
      case BEFORE_VALUE:
      case UNQUOTED:
      case QUOTED: {
        if (state === BEFORE_VALUE) {
          cur += '"'
          valueText = ""
          valueHoles = 0
          synthetic = true
        } else if (state === UNQUOTED) {
          const { part: at, offset } = unquotedAt
          if (at === part) cur = `${cur.slice(0, offset)}"${cur.slice(offset)}`
          else {
            const earlier = statics[at] ?? ""
            statics[at] = `${earlier.slice(0, offset)}"${earlier.slice(offset)}`
          }
          synthetic = true
        }
        state = QUOTED
        const kind = valueKind === URL_VALUE && !isBlank(valueText) ? ATTR : valueKind
        const lead = kind === URL_VALUE ? (valueHoles === 0 ? valueText.length : -1) : 0
        hole = { kind, lead, valued: false }
        valueHoles++
        break
      }
      case RAW:
        hole = { kind: rawCode ? CODE : TEXT, lead: 0, valued: false }
        break
      default:
        hole = { kind: TEXT, lead: 0, valued: false }
    }
    statics.push(cur)
    places.push(hole)
  }
  return {
    head: statics[0] ?? "",
    holes: places.map((place, i) => ({
      ...place,
      before: statics[i] ?? "",
      after: statics[i + 1] ?? "",
    })),
  }
}

const callSites = new WeakMap<readonly string[], CallSite>()

const unsupported = (value: unknown): TypeError =>
  // Objects/functions are a bug at the call site - render loudly rather than "[object Object]".
  new TypeError(
    `[nifra/web-vanilla] html: unsupported interpolation of type ${typeof value} - interpolate strings, numbers, nested html\`…\`, raw(), or arrays of those`,
  )

const POSITIONS: Record<number, string> = {
  [CODE]: "into a <script> or <style> body, an event handler or a srcdoc value",
  [TAG]: "as a tag name",
  [NAME]: "as an attribute name unless it is a plain name with no value, such as checked",
}

const refused = (kind: number): TypeError =>
  new TypeError(
    `[nifra/web-vanilla] html: a string or template cannot be interpolated ${POSITIONS[kind]}, where no escaping makes it safe - interpolate a number, or wrap trusted text in raw()`,
  )

function renderText(value: HtmlValue, ranges: SlotRange[], offset: number): string {
  if (value == null || value === false) return ""
  if (typeof value === "string") return escapeHtml(value)
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  if (value === true) return "true"
  if (value instanceof Template) {
    const slots = templateSlots.get(value)
    if (slots !== undefined)
      for (const range of slots)
        ranges.push({ name: range.name, start: offset + range.start, end: offset + range.end })
    return value.html
  }
  if (value instanceof RawHtml) return value.value
  if (Array.isArray(value)) {
    let out = ""
    for (const item of value) out += renderText(item, ranges, offset + out.length)
    return out
  }
  throw unsupported(value)
}

/** A value inside an attribute value, or where only numbers, booleans and raw() are safe. */
function renderIn(value: HtmlValue, hole: Hole): string {
  if (typeof value === "string") {
    if (hole.kind <= URL_VALUE) return escapeHtml(value)
    if (value === "" || (hole.kind === NAME && plainName(value, hole.valued))) return value
    throw refused(hole.kind)
  }
  if (value == null || value === false) return ""
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  if (value === true) return "true"
  if (value instanceof RawHtml) return value.value
  if (value instanceof Template) {
    if (hole.kind <= URL_VALUE) return escapeHtml(value.html)
    throw refused(hole.kind)
  }
  if (Array.isArray(value)) {
    let out = ""
    for (const item of value) out += renderIn(item, hole)
    return out
  }
  throw unsupported(value)
}

/** A valueless attribute name that cannot run code or load a URL. */
function plainName(name: string, valued: boolean): boolean {
  if (valued || !PLAIN_NAME.test(name)) return false
  const lower = name.toLowerCase()
  return !lower.startsWith("on") && lower !== "srcdoc" && !URL_ATTRIBUTES.has(lower)
}

/**
 * The text a URL value carries, before escaping: escaping rewrites none of the characters that
 * spell a scheme, and the escaped copy is a fresh string a character read would flatten.
 */
function urlText(value: HtmlValue): string {
  if (typeof value === "string") return value
  if (value instanceof Template) return value.html
  if (value instanceof RawHtml) return value.value
  if (Array.isArray(value)) {
    let text = ""
    for (const item of value) text += urlText(item)
    return text
  }
  return value == null || value === false ? "" : String(value)
}

/** Whether a URL value would run script when followed. */
function scriptUrl(url: string): boolean {
  // A URL parser drops leading controls and spaces, and tabs and newlines anywhere.
  let i = 0
  while (i < url.length && url.charCodeAt(i) <= 0x20) i++
  return schemeAt(url, i, "javascript:") || schemeAt(url, i, "vbscript:")
}

function schemeAt(url: string, start: number, scheme: string): boolean {
  let i = start
  for (let k = 0; k < scheme.length; i++) {
    if (i >= url.length) return false
    const c = url.charCodeAt(i)
    if (c === 9 || c === 10 || c === 13) continue
    // `| 0x20` lowercases an ASCII letter and leaves `:` as it is.
    if ((c | 0x20) !== scheme.charCodeAt(k)) return false
    k++
  }
  return true
}

/** The tag: `` html`<p>${user.name}</p>` `` → an escaped {@link Template}. */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): Template {
  let site = callSites.get(strings)
  if (site === undefined) {
    site = analyze(strings)
    callSites.set(strings, site)
  }
  let out = site.head
  const ranges: SlotRange[] = []
  let urlStart = 0
  let url = ""
  const holes = site.holes
  for (let i = 0; i < holes.length; i++) {
    const hole = holes[i]
    if (hole === undefined) break
    const value = values[i]
    if (hole.kind === TEXT) out += renderText(value, ranges, out.length) + hole.after
    else if (hole.kind === URL_VALUE) {
      if (hole.lead >= 0) {
        urlStart = out.length - hole.lead
        url = urlText(value)
      } else url += hole.before + urlText(value)
      out += renderIn(value, hole)
      if (scriptUrl(url)) out = `${out.slice(0, urlStart)}about:invalid`
      out += hole.after
    } else out += renderIn(value, hole) + hole.after
  }
  const template = new Template(out)
  if (ranges.length > 0) templateSlots.set(template, ranges)
  return template
}
