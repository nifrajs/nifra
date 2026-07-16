/**
 * Query-string and urlencoded-form parsing. Pure request-shaping helpers with no server internals:
 * the fast scanner for `c.query`, the repeated-key -> `string[]` promotion shared by query + form,
 * and the byte-capped HTML-form reader. Split out of the server kernel so the file stays one domain.
 */
import { readBoundedBytes } from "./body.ts"
import { jsonError, urlPartsOf } from "./http.ts"
import type { RequestSource } from "./server.ts"

// The query string ("?a=1", or "" when absent) - for lazily building `c.query` only when read.
// The fragment (after the first `#`) bounds the search: a `?` that appears only inside the fragment
// is NOT a query (matches WHATWG). Fragments never reach the server in `req.url`, so this is purely
// for provable equivalence with `new URL(req.url).search`.
export function searchOf(url: string): string {
  return urlPartsOf(url).search
}

/** A query value: a single occurrence is a string; a repeated key promotes to a string[] so an
 * array query schema (`t.array(t.string())`) can validate `?tag=a&tag=b` - last-wins silently
 * dropped values before (audit 2026-06). Single-occurrence keys stay plain strings, so existing
 * `t.string()` schemas are untouched; a repeated key against a string schema now FAILS validation
 * (an explicit 400 beats silently picking one). */
export type QueryValue = string | string[]

/** Accumulate into a NULL-PROTOTYPE record (every call site below creates one): with no inherited
 * `constructor`/`toString`/`__proto__` accessors, a hostile key is just an own data key - the
 * promotion logic can't collide with `Object.prototype` members, and `__proto__` needs no special
 * case (direct assignment on a null-proto object creates an own property). */
function setQueryValue(out: Record<string, QueryValue>, key: string, value: string): void {
  const existing = out[key]
  if (existing === undefined) {
    out[key] = value
  } else if (typeof existing === "string") {
    out[key] = [existing, value]
  } else {
    existing.push(value)
  }
}

function queryObjectFallback(search: string): Record<string, QueryValue> {
  // Manual iteration instead of Object.fromEntries: repeated keys must promote to arrays
  // (fromEntries is last-wins), and __proto__ needs the same own-property guard.
  const out: Record<string, QueryValue> = Object.create(null) as Record<string, QueryValue>
  for (const [key, value] of new URLSearchParams(search)) {
    setQueryValue(out, key, value)
  }
  return out
}

/**
 * Build the plain object passed to query schemas. Plain ASCII-ish queries avoid
 * `URLSearchParams` + iterator allocations; encoded queries fall back to the Web API so `+`,
 * percent-decoding, malformed escapes, and empty-key behavior stay exact. Repeated keys promote
 * to `string[]` on BOTH paths (see {@link setQueryValue}).
 */
// Shared empty result for no-query requests: frozen + null-prototype (same shape contract as the
// populated path), allocated once instead of per request.
const EMPTY_QUERY = Object.freeze(Object.create(null)) as Record<string, QueryValue>

export function queryObjectOf(search: string): Record<string, QueryValue> {
  const start = search.charCodeAt(0) === 63 /* ? */ ? 1 : 0
  if (start >= search.length) return EMPTY_QUERY

  for (let i = start; i < search.length; i++) {
    const c = search.charCodeAt(i)
    if (c === 37 /* % */ || c === 43 /* + */) return queryObjectFallback(search)
  }

  const out: Record<string, QueryValue> = Object.create(null) as Record<string, QueryValue>
  let pos = start
  while (pos <= search.length) {
    const amp = search.indexOf("&", pos)
    const end = amp === -1 ? search.length : amp
    if (end > pos) {
      const eq = search.indexOf("=", pos)
      const split = eq !== -1 && eq < end ? eq : end
      const key = search.slice(pos, split)
      const value = split === end ? "" : search.slice(split + 1, end)
      setQueryValue(out, key, value)
    }
    if (amp === -1) break
    pos = amp + 1
  }
  return out
}

/** `application/x-www-form-urlencoded`, with or without a charset suffix. */
export function isUrlEncodedForm(contentType: string): boolean {
  return (
    contentType === "application/x-www-form-urlencoded" ||
    contentType.startsWith("application/x-www-form-urlencoded;")
  )
}

const FORM_DECODER = new TextDecoder()

/**
 * Read an HTML-form body (urlencoded) into the plain object a body schema validates - same byte
 * cap as the JSON path (a lying/absent Content-Length can't force an oversized buffer), same
 * repeated-key -> `string[]` promotion as query parsing, same `__proto__` guard.
 */
export async function readBoundedForm(
  req: RequestSource,
  maxBytes: number,
): Promise<Record<string, QueryValue> | Response> {
  const read = await readBoundedBytes(req, maxBytes)
  if (!read.ok) {
    return read.status === 413
      ? jsonError(413, "payload_too_large")
      : jsonError(400, "invalid_content_length")
  }
  const out: Record<string, QueryValue> = Object.create(null) as Record<string, QueryValue>
  // URLSearchParams owns the format's quirks (`+` as space, percent-decoding, empty keys);
  // it never throws on junk input, so no try/catch is needed here.
  for (const [key, value] of new URLSearchParams(FORM_DECODER.decode(read.bytes))) {
    setQueryValue(out, key, value)
  }
  return out
}
