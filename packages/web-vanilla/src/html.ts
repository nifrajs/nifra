/**
 * The tagged-template HTML engine — `html` builds an escaped-by-construction {@link Template}.
 *
 * Security model (the part that matters): every interpolated value is HTML-escaped by default.
 * The ONLY ways to emit unescaped markup are (1) nesting another `html` template — already escaped
 * by construction — and (2) an explicit {@link raw} wrapper, which is the audit-greppable opt-out.
 * The escaper covers text and double-quoted attribute contexts (`& < > " '`); interpolations into
 * unquoted attributes or inline scripts are NOT safe by design — the docs say "always quote".
 */

/** Branded wrapper marking a string as pre-trusted markup. Construct only via {@link raw}. */
export class RawHtml {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
}

/**
 * Mark a string as trusted, pre-escaped markup — it is emitted verbatim. The deliberate escape
 * hatch (CMS-sanitized HTML, pre-rendered markdown): every call site is greppable, exactly like
 * React's dangerouslySetInnerHTML, without the JSX.
 */
export function raw(trusted: string): RawHtml {
  return new RawHtml(trusted)
}

const ESCAPE_RE = /[&<>"']/
const escapeHtml = (s: string): string => {
  // Fast path: most text has nothing to escape — one regex probe, zero allocation.
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

/** A rendered HTML fragment — what `html` returns and components produce. Stringified once. */
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

function renderValue(value: HtmlValue): string {
  if (value == null || value === false) return ""
  if (typeof value === "string") return escapeHtml(value)
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  if (value === true) return "true"
  if (value instanceof Template) return value.html
  if (value instanceof RawHtml) return value.value
  if (Array.isArray(value)) {
    let out = ""
    for (const item of value) out += renderValue(item)
    return out
  }
  // Objects/functions are a bug at the call site — render loudly rather than "[object Object]".
  throw new TypeError(
    `[nifra/web-vanilla] html: unsupported interpolation of type ${typeof value} — interpolate strings, numbers, nested html\`…\`, raw(), or arrays of those`,
  )
}

/** The tag: `` html`<p>${user.name}</p>` `` → an escaped {@link Template}. */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): Template {
  let out = strings[0] as string
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i] as HtmlValue) + (strings[i + 1] as string)
  }
  return new Template(out)
}
