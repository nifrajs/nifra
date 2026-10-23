import { describe, expect, test } from "bun:test"
import { constants, deflateRawSync, inflateRawSync } from "node:zlib"
import { FIXED_DEFLATE_MAX, fixedDeflate } from "../src/_fixed-deflate.ts"

const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const inflate = (segment: Uint8Array, dictionary: Uint8Array): Buffer =>
  inflateRawSync(
    segment,
    dictionary.byteLength === 0
      ? { finishFlush: constants.Z_SYNC_FLUSH }
      : { finishFlush: constants.Z_SYNC_FLUSH, dictionary },
  )

/** A seeded generator, so a failing case can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32
  }
}

describe("fixedDeflate", () => {
  test("any chunk up to its limit inflates back after any dictionary", () => {
    const next = random(0x5eed)
    for (let run = 0; run < 3000; run++) {
      // Small alphabets make long and overlapping matches; large ones mostly literals.
      const alphabet = 1 + Math.floor(next() * (next() < 0.5 ? 4 : 256))
      const bytes = (length: number) =>
        Uint8Array.from({ length }, () => Math.floor(next() * alphabet))
      const chunk = bytes(Math.floor(next() * (FIXED_DEFLATE_MAX + 1)))
      const dictionary = bytes(Math.floor(next() * 3000))
      const segment = fixedDeflate(chunk, dictionary, Number.POSITIVE_INFINITY)
      if (segment === undefined) throw new Error("no segment without a limit")
      const back = inflate(segment, dictionary)
      if (Buffer.compare(back, chunk) !== 0) {
        throw new Error(`run ${run}: ${chunk.byteLength} bytes after ${dictionary.byteLength}`)
      }
    }
  })

  test("the longest matches, the farthest distance and the shortest chunks", () => {
    const run = new Uint8Array(FIXED_DEFLATE_MAX).fill(0x61)
    const longest = fixedDeflate(run, new Uint8Array(0), Number.POSITIVE_INFINITY)
    expect(longest).toBeDefined()
    expect(longest!.byteLength).toBeLessThan(20)
    expect(Buffer.compare(inflate(longest!, new Uint8Array(0)), run)).toBe(0)

    const dictionary = text(`<head>${"x".repeat(2042)}`)
    const far = text("<head>")
    const reached = fixedDeflate(far, dictionary, Number.POSITIVE_INFINITY)
    expect(Buffer.compare(inflate(reached!, dictionary), far)).toBe(0)
    // Only the dictionary's last 2 KB are reached into, and a decoder holding more still agrees.
    const longer = text(`<head>${"x".repeat(5000)}`)
    expect(Buffer.compare(inflate(fixedDeflate(far, longer, Infinity)!, longer), far)).toBe(0)

    for (const short of [new Uint8Array(0), text("a"), text("ab"), text("abc")]) {
      const segment = fixedDeflate(short, text("abcabc"), Number.POSITIVE_INFINITY)
      expect(Buffer.compare(inflate(segment!, text("abcabc")), short)).toBe(0)
    }
  })

  test("past its limit, or past its largest chunk, it leaves the chunk to zlib", () => {
    const next = random(0x401e)
    const noise = Uint8Array.from({ length: 600 }, () => Math.floor(next() * 256))
    expect(fixedDeflate(noise, new Uint8Array(0), 300)).toBeUndefined()
    expect(fixedDeflate(noise, new Uint8Array(0), Number.POSITIVE_INFINITY)).toBeDefined()
    // The limit counts the sync flush's four bytes too.
    const exact = fixedDeflate(text("hi"), new Uint8Array(0), Number.POSITIVE_INFINITY)!
    expect(fixedDeflate(text("hi"), new Uint8Array(0), exact.byteLength - 1)).toBeUndefined()
    expect(fixedDeflate(text("hi"), new Uint8Array(0), exact.byteLength)).toBeDefined()
    const large = new Uint8Array(FIXED_DEFLATE_MAX + 1)
    expect(fixedDeflate(large, new Uint8Array(0), Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  test("on markup after markup, about as small as zlib", () => {
    const dictionary = text(
      Array.from(
        { length: 40 },
        (_, at) => `<li class="item"><a href="/tea/${at}">Tea ${at}</a></li>`,
      )
        .join("")
        .slice(-2048),
    )
    const frame = text(
      `<script type="application/json" id="frame">{"html":"<li class=\\"item\\"><a href=\\"/tea/7\\">Tea 7</a></li>"}</script>`,
    )
    const ours = fixedDeflate(frame, dictionary, Number.POSITIVE_INFINITY)!
    const zlibs = deflateRawSync(frame, { finishFlush: constants.Z_SYNC_FLUSH, dictionary })
    expect(ours.byteLength).toBeLessThanOrEqual(Math.ceil(zlibs.byteLength * 1.1))
  })
})
