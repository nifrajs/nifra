/**
 * Raw deflate of a small chunk in JavaScript: one block of the fixed Huffman codes (RFC 1951 3.2.6),
 * whose matches may reach back into `dictionary`, ending in a sync flush so the result joins other
 * segments of one deflate stream. On Bun, zlib took 8-10 us for a chunk of 128-512 bytes after a 2 KB
 * dictionary, most of it setting up its stream; this took 3-4 us, and on page markup that short came
 * out as small as zlib's, which picks fixed codes for a short block too.
 */

/** The largest chunk this takes: past it zlib's dynamic codes pull ahead (page markup: 1.07x zlib's
 * bytes at 1 KB, 1.28x at 2 KB). */
export const FIXED_DEFLATE_MAX = 1024
const DICTIONARY_MAX = 2 * 1024
const MIN_MATCH = 3
const MAX_MATCH = 258
// Candidates tried per position: 1 to 16 changed the size by 7% and the time by nothing measurable.
const CHAIN = 8
const HASH_BITS = 12
const HASH_MASK = (1 << HASH_BITS) - 1
// Three shifts push a byte out of the hash, as zlib's UPDATE_HASH.
const HASH_SHIFT = Math.ceil(HASH_BITS / 3)

const reversed = (code: number, length: number): number => {
  let out = 0
  for (let bit = 0; bit < length; bit++) {
    out = (out << 1) | ((code >> bit) & 1)
  }
  return out
}

// Huffman codes go out most significant bit first, so each is stored reversed for an LSB-first writer.
const SYMBOL_CODE = new Uint16Array(288)
const SYMBOL_BITS = new Uint8Array(288)
for (let symbol = 0; symbol < 288; symbol++) {
  const [first, from, bits] =
    symbol < 144
      ? [0x30, 0, 8]
      : symbol < 256
        ? [0x190, 144, 9]
        : symbol < 280
          ? [0, 256, 7]
          : [0xc0, 280, 8]
  SYMBOL_CODE[symbol] = reversed(first + symbol - from, bits)
  SYMBOL_BITS[symbol] = bits
}

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
const LENGTH_SYMBOL = new Uint16Array(MAX_MATCH + 1)
const LENGTH_EXTRA_BITS = new Uint8Array(MAX_MATCH + 1)
const LENGTH_EXTRA_VALUE = new Uint8Array(MAX_MATCH + 1)
for (let code = 0; code < 29; code++) {
  const base = LENGTH_BASE[code]!
  // 258 has a code of its own; 227 + 31 would also reach it.
  const last = code === 27 ? 257 : code === 28 ? 258 : LENGTH_BASE[code + 1]! - 1
  for (let length = base; length <= last; length++) {
    LENGTH_SYMBOL[length] = 257 + code
    LENGTH_EXTRA_BITS[length] = LENGTH_EXTRA[code]!
    LENGTH_EXTRA_VALUE[length] = length - base
  }
}

const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073,
]
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10]
const DISTANCE_CODE = DISTANCE_BASE.map((_, code) => reversed(code, 5))

/** Reused by every call: a call runs to its end before the next. */
let scratch:
  | { readonly head: Int32Array; readonly previous: Int32Array; readonly bytes: Uint8Array }
  | undefined

/**
 * `chunk` (at most {@link FIXED_DEFLATE_MAX} bytes) deflated after `dictionary` (its last 2 KB are
 * used), or `undefined` once the output passes `limit` bytes: a chunk fixed codes cannot shrink that
 * far is left to zlib, whose dynamic codes may.
 */
export function fixedDeflate(
  chunk: Uint8Array,
  dictionary: Uint8Array,
  limit: number,
): Uint8Array | undefined {
  if (chunk.byteLength > FIXED_DEFLATE_MAX) return undefined
  const history =
    dictionary.byteLength > DICTIONARY_MAX
      ? dictionary.subarray(dictionary.byteLength - DICTIONARY_MAX)
      : dictionary
  scratch ??= {
    head: new Int32Array(1 << HASH_BITS),
    previous: new Int32Array(DICTIONARY_MAX + FIXED_DEFLATE_MAX),
    bytes: new Uint8Array(DICTIONARY_MAX + FIXED_DEFLATE_MAX),
  }
  const { head, previous, bytes } = scratch
  const start = history.byteLength
  const end = start + chunk.byteLength
  bytes.set(history, 0)
  bytes.set(chunk, start)
  head.fill(-1)
  // Positions up to `lastHashed` have three bytes to hash; each hash is the previous one shifted.
  const lastHashed = end - MIN_MATCH
  let hash = end >= 2 ? ((bytes[0]! << HASH_SHIFT) ^ bytes[1]!) & HASH_MASK : 0
  for (let at = 0; at < start && at <= lastHashed; at++) {
    hash = ((hash << HASH_SHIFT) ^ bytes[at + 2]!) & HASH_MASK
    previous[at] = head[hash]!
    head[hash] = at
  }

  // A literal costs at most 9 bits and a match at most 22 for its 3 bytes, so this always fits.
  const out = new Uint8Array(chunk.byteLength + (chunk.byteLength >> 3) + 8)
  const stop = Math.min(limit, out.byteLength)
  let written = 0
  // BFINAL 0, then BTYPE 01: fixed codes.
  let bits = 0b010
  let pending = 3
  let at = start
  while (at < end) {
    let length = 0
    let distance = 0
    if (at <= lastHashed) {
      hash = ((hash << HASH_SHIFT) ^ bytes[at + 2]!) & HASH_MASK
      const longest = end - at < MAX_MATCH ? end - at : MAX_MATCH
      let candidate = head[hash]!
      for (let tries = CHAIN; candidate >= 0 && tries > 0; tries--) {
        if (bytes[candidate + length] === bytes[at + length]) {
          let matched = 0
          while (matched < longest && bytes[candidate + matched] === bytes[at + matched]) matched++
          if (matched > length) {
            length = matched
            distance = at - candidate
            if (matched === longest) break
          }
        }
        candidate = previous[candidate]!
      }
      previous[at] = head[hash]!
      head[hash] = at
    }
    if (length >= MIN_MATCH) {
      const symbol = LENGTH_SYMBOL[length]!
      bits |=
        (SYMBOL_CODE[symbol]! | (LENGTH_EXTRA_VALUE[length]! << SYMBOL_BITS[symbol]!)) << pending
      pending += SYMBOL_BITS[symbol]! + LENGTH_EXTRA_BITS[length]!
      while (pending >= 8) {
        out[written++] = bits & 0xff
        bits >>>= 8
        pending -= 8
      }
      let code = DISTANCE_BASE.length - 1
      while (DISTANCE_BASE[code]! > distance) code--
      bits |= (DISTANCE_CODE[code]! | ((distance - DISTANCE_BASE[code]!) << 5)) << pending
      pending += 5 + DISTANCE_EXTRA[code]!
      for (const matchEnd = at + length; ++at < matchEnd; ) {
        if (at > lastHashed) continue
        hash = ((hash << HASH_SHIFT) ^ bytes[at + 2]!) & HASH_MASK
        previous[at] = head[hash]!
        head[hash] = at
      }
    } else {
      const literal = bytes[at]!
      bits |= SYMBOL_CODE[literal]! << pending
      pending += SYMBOL_BITS[literal]!
      at++
    }
    while (pending >= 8) {
      out[written++] = bits & 0xff
      bits >>>= 8
      pending -= 8
    }
    if (written > stop) return undefined
  }
  // The end-of-block code is seven zero bits, and an empty stored block's header three more.
  pending += 7 + 3
  while (pending > 0) {
    out[written++] = bits & 0xff
    bits >>>= 8
    pending -= 8
  }
  if (written + 4 > limit) return undefined
  out[written++] = 0
  out[written++] = 0
  out[written++] = 0xff
  out[written++] = 0xff
  return out.subarray(0, written)
}
