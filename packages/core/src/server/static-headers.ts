/**
 * The static response-header tier: registration-time validation, the prebuilt per-server shapes the
 * render paths reuse, and the one merge routine every lane folds them in with.
 *
 * A statically declared header is a DEFAULT. It carries no per-request decision, so it does not need
 * to run as a response hook - it is folded into response construction instead, which is what lets an
 * app whose only response middleware is static keep the fused/native lanes a real `onResponse` hook
 * would have cost it. Anything the request itself produced (`c.set.headers`, a cookie, a response
 * hook) is applied later and therefore wins.
 */

/** Valid HTTP field-name characters (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * Names the tier refuses outright, so a static declaration can never fight the render:
 * `content-length`/`transfer-encoding` are framing the writers derive from the final bytes,
 * `content-type` is the render's own (declare it per response instead), and `set-cookie` is the one
 * multi-value header a `Record<string, string>` cannot represent - queue those with `c.set.cookie`.
 */
const REFUSED_HEADERS: ReadonlySet<string> = new Set([
  "content-length",
  "content-type",
  "set-cookie",
  "transfer-encoding",
])

/** The per-server shapes built once from a validated static record. */
export interface StaticResponseHeaders {
  /** Lowercase-keyed and frozen: shared by every request, so no lane may mutate it. */
  readonly record: Readonly<Record<string, string>>
  /** `record` as pairs, for applying to an already-built `Headers`/`Response`. */
  readonly entries: ReadonlyArray<readonly [string, string]>
  /** The static record plus the content-type the framework's own JSON init carries, prebuilt. A
   * `Response` init is copied into the response, never retained, so one instance serves every
   * request. */
  readonly jsonHeaders: Headers
  /** `{ status: 200, headers: jsonHeaders }` - a static app's whole per-response header cost. */
  readonly jsonInit200: ResponseInit
  /**
   * The same shape, but carrying the content-type THIS runtime's `Response.json` emits - which is not
   * always the framework init's (Deno omits the charset). Used by the lane that would otherwise call
   * `Response.json`, so declaring headers never changes the content-type. Probed on first use:
   * workerd forbids `Response.json()` during startup, and declarations happen at startup.
   */
  responseJsonInit200(): ResponseInit
}

/** CR, LF, or NUL in a declared value would forge extra header lines on the wire. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 13 || code === 10 || code === 0) return true
  }
  return false
}

/**
 * Validate a declared record and lowercase its names once, at registration. Every rejection is a
 * programming error surfaced loudly at wire-up rather than a header silently missing (or, for the
 * refused names, silently corrupting framing) on every response afterwards.
 */
export function normalizeStaticResponseHeaders(
  record: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of Object.keys(record)) {
    const value = record[name]
    if (typeof value !== "string") {
      throw new TypeError(`responseHeaders: the value of "${name}" must be a string`)
    }
    if (!HEADER_NAME.test(name)) {
      throw new TypeError(`responseHeaders: "${name}" is not a valid header name`)
    }
    if (hasControlCharacter(value)) {
      throw new TypeError(`responseHeaders: the value of "${name}" contains a control character`)
    }
    if (value !== value.trim()) {
      throw new TypeError(`responseHeaders: the value of "${name}" has leading or trailing space`)
    }
    const lower = name.toLowerCase()
    // A `__proto__` entry cannot be stored by plain assignment (the inherited setter swallows it),
    // and a header nobody can observe is worse than a refusal at wire-up.
    if (lower === "__proto__") {
      throw new TypeError('responseHeaders: "__proto__" is not a usable header name')
    }
    if (REFUSED_HEADERS.has(lower)) {
      throw new TypeError(
        `responseHeaders: "${lower}" is set per response, not statically - use c.set.headers (or c.set.cookie for set-cookie)`,
      )
    }
    out[lower] = value
  }
  return out
}

/**
 * Store an own-property under a name that may be `__proto__`. Mirrors the native header view's
 * store: a literal-shaped record keeps V8/JSC's fast object shape (a null-prototype record demotes
 * to dictionary mode), so the one name plain assignment would swallow is defined explicitly.
 */
function store<V>(record: Record<string, V>, name: string, value: V): void {
  if (name === "__proto__") {
    Object.defineProperty(record, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
    return
  }
  record[name] = value
}

/**
 * Fold the static defaults UNDER a record the request produced. A name the request set wins, keeping
 * the casing it used; when the two spellings differ only by case, the static entry is dropped rather
 * than left alongside - one header name spelled two ways in a single record ships as a comma-joined
 * value on the Web paths and as two lines on Node, so writing the static entry blind would change
 * the wire instead of being overridden.
 */
export function mergeStaticHeaderRecord<V>(
  statics: Readonly<Record<string, string>>,
  own: Readonly<Record<string, V>>,
): Record<string, V | string> {
  const merged: Record<string, V | string> = { ...statics }
  for (const name of Object.keys(own)) {
    const value = own[name] as V
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower !== name && Object.hasOwn(merged, lower)) delete merged[lower]
    store(merged, name, value)
  }
  return merged
}

/** A fresh, mutable copy of the static record - what the lanes whose writers mutate the record get. */
export function staticHeaderRecordCopy(
  statics: StaticResponseHeaders,
): Record<string, string | readonly string[]> {
  return { ...statics.record }
}
