import { definePlugin } from "@nifrajs/core/server"

export interface LanguageMatch {
  readonly language: string
  readonly matched: "exact" | "base" | "wildcard" | "default"
}

export interface LanguageOptions<L extends readonly string[]> {
  readonly supported: L
  readonly defaultLanguage: L[number]
  /** Emit `Content-Language`. Default `true`. */
  readonly header?: boolean
}

interface Range {
  readonly tag: string
  readonly q: number
  readonly order: number
}

function parseAcceptLanguage(header: string | null): Range[] {
  if (header === null) return []
  const ranges: Range[] = []
  let order = 0
  for (const part of header.split(",")) {
    const pieces = part.split(";").map((p) => p.trim())
    const tag = (pieces[0] ?? "").toLowerCase()
    if (tag === "") continue
    let q = 1
    for (const piece of pieces.slice(1)) {
      const [name, raw] = piece.split("=")
      if (name?.toLowerCase() !== "q" || raw === undefined) continue
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        q = 0
      } else {
        q = parsed
      }
    }
    if (q > 0) ranges.push({ tag, q, order })
    order += 1
  }
  return ranges.sort((a, b) => b.q - a.q || a.order - b.order)
}

function baseOf(tag: string): string {
  const dash = tag.indexOf("-")
  return dash === -1 ? tag : tag.slice(0, dash)
}

/**
 * Pick the best supported language for an `Accept-Language` header. Exact tags win, then compatible
 * base-language matches, then `*`, then the configured default.
 */
export function pickLanguage<const L extends readonly string[]>(
  header: string | null,
  supported: L,
  defaultLanguage: L[number],
): LanguageMatch {
  if (supported.length === 0) throw new Error("pickLanguage: supported must not be empty")
  if (!supported.includes(defaultLanguage)) {
    throw new Error("pickLanguage: defaultLanguage must be in supported")
  }
  const lower = new Map(supported.map((value) => [value.toLowerCase(), value] as const))
  const ranges = parseAcceptLanguage(header)
  for (const range of ranges) {
    if (range.tag === "*") return { language: defaultLanguage, matched: "wildcard" }
    const exact = lower.get(range.tag)
    if (exact !== undefined) return { language: exact, matched: "exact" }
    const requestedBase = baseOf(range.tag)
    for (const value of supported) {
      const candidate = value.toLowerCase()
      if (baseOf(candidate) === requestedBase) return { language: value, matched: "base" }
    }
  }
  return { language: defaultLanguage, matched: "default" }
}

/**
 * Derives `c.language` from `Accept-Language` and emits `Content-Language` by default.
 *
 * Header-only by design. For the full detector - `?lang=` query parameter → cookie →
 * `Accept-Language`, with optional cookie persistence - use `localeDetector()` from
 * `@nifrajs/i18n/detector`; use one or the other, not both.
 */
export function language<const L extends readonly string[]>(options: LanguageOptions<L>) {
  const { supported, defaultLanguage } = options
  if (supported.length === 0) throw new Error("language: supported must not be empty")
  if (!supported.includes(defaultLanguage)) {
    throw new Error("language: defaultLanguage must be in supported")
  }
  const emitHeader = options.header !== false
  // The match is a pure function of the Accept-Language header, so the response hooks recompute it
  // instead of pairing state through a WeakMap - that is what lets the Node twin exist at all (it
  // has no `Request` identity to key on), keeps both hooks trivially identical, and lets the derive
  // read the header without materializing a Web `Request` on the Node adapter.
  return definePlugin("language", (app) =>
    app
      .derive((c) => {
        const match = pickLanguage(c.header("accept-language"), supported, defaultLanguage)
        return { language: match.language, languageMatch: match }
      })
      .use({
        onResponseHeaders(headers, req) {
          if (!emitHeader) return
          if (headers.has("content-language")) return
          const match = pickLanguage(req.header("accept-language"), supported, defaultLanguage)
          headers.set("content-language", match.language)
        },
      }),
  )
}
