export interface ContentPreference {
  readonly type: string
  readonly subtype: string
  readonly q: number
  readonly specificity: 0 | 1 | 2
}

interface ParsedMediaType extends ContentPreference {
  readonly parameters: ReadonlyMap<string, string>
}

const MAX_ACCEPT_HEADER_LENGTH = 16 * 1024
const MAX_MEDIA_RANGES = 128

function splitHeader(value: string): string[] | undefined {
  if (value.length > MAX_ACCEPT_HEADER_LENGTH) return undefined
  const parts: string[] = []
  let start = 0
  let quoted = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted
    if (character === "," && !quoted) {
      parts.push(value.slice(start, index))
      if (parts.length >= MAX_MEDIA_RANGES) return undefined
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

function parseMediaType(value: string, qDefault = 1): ParsedMediaType | undefined {
  const segments = value.split(";")
  const media = segments.shift()?.trim().toLowerCase() ?? ""
  const slash = media.indexOf("/")
  if (slash <= 0 || slash === media.length - 1) return undefined
  const type = media.slice(0, slash)
  const subtype = media.slice(slash + 1)
  if (!/^[\w!#$&^_.+-]+$/.test(type) || !/^[\w!#$&^_.+*-]+$/.test(subtype)) return undefined

  let q = qDefault
  const parameters = new Map<string, string>()
  for (const segment of segments) {
    const separator = segment.indexOf("=")
    if (separator < 1) continue
    const key = segment.slice(0, separator).trim().toLowerCase()
    const raw = segment.slice(separator + 1).trim()
    const parameter = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
    if (key === "q") {
      const parsed = Number(parameter)
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return undefined
      q = parsed
    } else {
      parameters.set(key, parameter.toLowerCase())
    }
  }
  const specificity: 0 | 1 | 2 = type === "*" ? 0 : subtype === "*" ? 1 : 2
  return { type, subtype, q, specificity, parameters }
}

/** Parse an `Accept` header, preserving quality and wildcard specificity. */
export function parseAcceptHeader(value: string | null): readonly ContentPreference[] {
  if (value === null || value.trim() === "") return []
  const preferences: ContentPreference[] = []
  for (const item of splitHeader(value) ?? []) {
    const parsed = parseMediaType(item)
    if (parsed !== undefined) preferences.push(parsed)
  }
  return preferences
}

function parsedAcceptHeader(value: string): readonly ParsedMediaType[] {
  const preferences: ParsedMediaType[] = []
  for (const item of splitHeader(value) ?? []) {
    const parsed = parseMediaType(item)
    if (parsed !== undefined) preferences.push(parsed)
  }
  return preferences
}

function offeredMatches(offer: ParsedMediaType, preference: ParsedMediaType): boolean {
  if (preference.type !== "*" && preference.type !== offer.type) return false
  if (preference.subtype !== "*" && preference.subtype !== offer.subtype) return false
  for (const [key, value] of preference.parameters) {
    if (offer.parameters.get(key) !== value) return false
  }
  return true
}

function acceptHeaderOf(value: string | null | Headers | Request): string | null {
  if (typeof value === "string" || value === null) return value
  return value instanceof Request ? value.headers.get("accept") : value.get("accept")
}

/**
 * Select the best offered media type for an `Accept` header. The returned string is the original
 * offered value, so parameters such as `profile` are preserved. An absent/empty header accepts the
 * first offer; an explicit `q=0` or no matching offer returns `undefined`.
 */
export function negotiateContentType(
  accept: string | null | Headers | Request,
  offered: readonly string[],
): string | undefined {
  if (offered.length === 0) return undefined
  const header = acceptHeaderOf(accept)
  if (header === null || header.trim() === "") return offered[0]
  const preferences = parsedAcceptHeader(header)
  let selected:
    | {
        readonly value: string
        readonly q: number
        readonly specificity: number
        readonly index: number
      }
    | undefined

  offered.forEach((value, index) => {
    const parsed = parseMediaType(value, 0)
    if (parsed === undefined) return
    let best: ParsedMediaType | undefined
    for (const preference of preferences) {
      if (!offeredMatches(parsed, preference)) continue
      if (best === undefined || preference.specificity > best.specificity) best = preference
    }
    if (best === undefined || best.q === 0) return
    if (
      selected === undefined ||
      best.q > selected.q ||
      (best.q === selected.q && best.specificity > selected.specificity)
    ) {
      selected = { value, q: best.q, specificity: best.specificity, index }
    }
  })
  return selected?.value
}
