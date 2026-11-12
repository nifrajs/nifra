// One URL path segment, encoded and decoded. Every place that spells a value into a path calls this
// module, so a link, a prerendered file, a client request and a public asset agree on one spelling.

const HEX = "0123456789ABCDEF"

const UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

function rawTable(chars: string): Uint8Array {
  const table = new Uint8Array(128)
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = 1
  return table
}

// RFC 3986 `pchar` minus `;`: the unreserved set, the sub-delimiters, `:` and `@`. `;` delimits path
// parameters (RFC 3986 section 3.3) and servlet containers strip them; `[`, `]` and `|` are not valid in
// a path at all and Tomcat rejects them unencoded by default.
const CANONICAL = /* @__PURE__ */ rawTable(`${UNRESERVED}!$&'()*+,:=@`)

// What a browser leaves as written in a path: the canonical set plus `;`, `[`, `]` and `|`.
const BROWSER = /* @__PURE__ */ rawTable(`${UNRESERVED}!$&'()*+,:=@;[]|`)

function encodeNonAscii(run: string): string {
  try {
    return encodeURIComponent(run)
  } catch {
    throw new RangeError("[nifra/core] a path segment cannot hold a lone surrogate")
  }
}

function encodeWith(raw: Uint8Array, value: string): string {
  if (value === "." || value === "..") {
    throw new RangeError(
      `[nifra/core] a path segment cannot be ${JSON.stringify(value)}: every spelling of it is a dot segment to a URL parser`,
    )
  }
  const length = value.length
  let out = ""
  let start = 0
  let i = 0
  while (i < length) {
    const code = value.charCodeAt(i)
    if (code < 128 && raw[code] === 1) {
      i++
      continue
    }
    out += value.slice(start, i)
    if (code < 128) {
      out += `%${HEX[code >> 4]}${HEX[code & 15]}`
      i++
    } else {
      let end = i + 1
      while (end < length && value.charCodeAt(end) >= 128) end++
      out += encodeNonAscii(value.slice(i, end))
      i = end
    }
    start = i
  }
  return start === 0 ? value : out + value.slice(start)
}

/**
 * `value` as one path segment. Left as written: letters, digits, the at sign and `- . _ ~ ! $ & ' ( ) * + , : =`.
 * Everything else is percent-encoded, UTF-8 and upper-case hex, including `; [ ] | / ? # % \`.
 *
 * Throws a `RangeError` for a value that no segment can carry: exactly `.` or `..` (a URL parser reads
 * `%2E` and `%2E%2E` as dot segments too) and a lone surrogate (substituting U+FFFD would map distinct
 * values to one URL). The empty string is returned as is; a caller that cannot use it checks for it.
 */
export function encodePathSegment(value: string): string {
  return encodeWith(CANONICAL, value)
}

/**
 * `value` as a browser spells it in a request URL: {@link encodePathSegment} with `; [ ] |` left as
 * written. Used for one thing, registering a public file under the spelling its page links request;
 * it differs from the canonical form on those four characters only.
 */
export function browserPathSegment(value: string): string {
  return encodeWith(BROWSER, value)
}

/**
 * `raw` with its percent-escapes decoded, or `undefined` when one is malformed. The inverse of
 * {@link encodePathSegment} and of {@link browserPathSegment}; a segment in any other spelling decodes
 * too. What a malformed escape means is the caller's policy.
 */
export function decodePathSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}
