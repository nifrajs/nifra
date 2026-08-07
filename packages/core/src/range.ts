/**
 * `Range: bytes=...` parsing - the shared owner for every byte-range surface in the framework.
 *
 * This lives in core rather than in the middleware package because two unrelated layers need the
 * exact same answer: `@nifrajs/middleware`'s `rangeResponse` for caller-owned buffers, and
 * `@nifrajs/web`'s `public/` static handler for files on disk. A second implementation that happens
 * to agree today is how a media server ends up serving byte 0 of a seek request in one code path and
 * byte N in the other.
 *
 * The input is request-controlled on every call, so the parser is bounded before it is clever: a
 * capped header length and a capped specifier count keep a malformed range-set from turning a sort
 * and merge into an allocation amplifier.
 */

export interface ByteRange {
  readonly start: number
  readonly end: number
}

export type ByteRangeResult =
  | { readonly kind: "none" }
  | { readonly kind: "unsatisfiable" }
  | { readonly kind: "satisfiable"; readonly ranges: readonly ByteRange[] }

const INTEGER = /^(?:0|[1-9]\d*)$/
const MAX_RANGE_HEADER_LENGTH = 16 * 1024
const MAX_RANGE_SPECIFIERS = 16

function validSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError("parseByteRange: size must be a non-negative safe integer")
  }
}

/**
 * Parse an HTTP `Range: bytes=...` header against a known representation size.
 *
 * Three outcomes, and the distinction matters to the caller's status code: `none` means the header
 * was absent or syntactically invalid and must be ignored (200), `unsatisfiable` means a well-formed
 * range-set selected nothing (416), `satisfiable` carries the coalesced ranges (206).
 */
export function parseByteRange(value: string | null, size: number): ByteRangeResult {
  validSize(size)
  if (value === null) return { kind: "none" }
  const match = /^bytes\s*=\s*(.+)$/i.exec(value)
  if (match === null) return { kind: "none" }
  const source = match[1]!
  if (source.length > MAX_RANGE_HEADER_LENGTH) return { kind: "none" }
  let separators = 0
  for (const character of source) {
    if (character === "," && ++separators >= MAX_RANGE_SPECIFIERS) return { kind: "none" }
  }

  const ranges: ByteRange[] = []
  let validRangeSpec = false
  for (const raw of source.split(",")) {
    const item = raw.trim()
    const dash = item.indexOf("-")
    if (dash < 0) continue
    const left = item.slice(0, dash).trim()
    const right = item.slice(dash + 1).trim()
    if (left === "" && (!INTEGER.test(right) || right === "0")) continue
    if (left !== "" && !INTEGER.test(left)) continue
    if (right !== "" && !INTEGER.test(right)) continue
    validRangeSpec = true

    let start: number
    let end: number
    if (left === "") {
      const suffix = Number(right)
      start = suffix >= size ? 0 : size - suffix
      end = size - 1
    } else {
      start = Number(left)
      end = right === "" ? size - 1 : Math.min(Number(right), size - 1)
    }
    if (start > end || start >= size || size === 0) continue
    ranges.push({ start, end })
  }

  // A syntactically invalid Range header is ignored; a valid range-set with no overlap is 416.
  if (ranges.length === 0) return validRangeSpec ? { kind: "unsatisfiable" } : { kind: "none" }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: ByteRange[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.start <= previous.end + 1) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) }
    } else {
      merged.push(range)
    }
  }
  return { kind: "satisfiable", ranges: merged }
}
