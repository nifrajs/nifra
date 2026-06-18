import { describe, expect, test } from "bun:test"
import { imageDimensions, readImageDimensions } from "../src/index.ts"

// A 1×1 PNG (real bytes).
const PNG_1x1 = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
)

/** Build a minimal valid header (only the bytes the parser reads need to be right). */
const gif = (w: number, h: number): Uint8Array =>
  new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 0xff, w >> 8, h & 0xff, h >> 8, 0, 0, 0])

const jpeg = (w: number, h: number): Uint8Array => {
  // SOI + a SOF0 marker (@2): length @4, precision @6, height @7, width @9 (marker+5 / marker+7).
  const b = new Uint8Array(12)
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11])
  const dv = new DataView(b.buffer)
  dv.setUint16(7, h)
  dv.setUint16(9, w)
  return b
}

const webpHeader = (chunk: string, body: Uint8Array): Uint8Array => {
  // The chunk body starts at offset 16, so the array must fit 16 + body.length (≥30 for VP8X).
  const b = new Uint8Array(Math.max(30, 16 + body.length))
  b.set([0x52, 0x49, 0x46, 0x46]) // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  b.set(
    [...chunk].map((c) => c.charCodeAt(0)),
    12,
  )
  b.set(body, 16)
  return b
}

describe("imageDimensions", () => {
  test("PNG (real 1×1)", () => {
    expect(imageDimensions(PNG_1x1)).toEqual({ width: 1, height: 1, format: "png" })
  })

  test("GIF", () => {
    expect(imageDimensions(gif(640, 480))).toEqual({ width: 640, height: 480, format: "gif" })
  })

  test("JPEG (SOF0; skips an earlier segment)", () => {
    expect(imageDimensions(jpeg(800, 600))).toEqual({ width: 800, height: 600, format: "jpeg" })
    // a JPEG with a leading APP0 segment before the SOF0 → the scanner skips it
    const withApp0 = new Uint8Array(24)
    withApp0.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x06, 1, 2, 3, 4, 0xff, 0xc0, 0x00, 0x11])
    new DataView(withApp0.buffer).setUint16(15, 120) // height @ off+5 (off=10)
    new DataView(withApp0.buffer).setUint16(17, 240) // width @ off+7
    expect(imageDimensions(withApp0)).toEqual({ width: 240, height: 120, format: "jpeg" })
  })

  test("WebP — VP8 (lossy), VP8L (lossless), VP8X (extended)", () => {
    const vp8 = new Uint8Array(20)
    new DataView(vp8.buffer).setUint16(10, 320, true) // width @26 (16 into the body at +16)
    new DataView(vp8.buffer).setUint16(12, 200, true) // height @28
    expect(imageDimensions(webpHeader("VP8 ", vp8))).toEqual({
      width: 320,
      height: 200,
      format: "webp",
    })

    const vp8l = new Uint8Array(20)
    vp8l[4] = 0x2f // signature @20 (body offset 4)
    // bits @21: (width-1) in low 14, (height-1) in next 14. width=16, height=8 → 15 | (7<<14).
    new DataView(vp8l.buffer).setUint32(5, 15 | (7 << 14), true)
    expect(imageDimensions(webpHeader("VP8L", vp8l))).toEqual({
      width: 16,
      height: 8,
      format: "webp",
    })

    const vp8x = new Uint8Array(20)
    // 24-bit (width-1) @24 (body offset 8), 24-bit (height-1) @27 (body offset 11). w=4000,h=3000.
    vp8x[8] = 3999 & 0xff
    vp8x[9] = (3999 >> 8) & 0xff
    vp8x[11] = 2999 & 0xff
    vp8x[12] = (2999 >> 8) & 0xff
    expect(imageDimensions(webpHeader("VP8X", vp8x))).toEqual({
      width: 4000,
      height: 3000,
      format: "webp",
    })
  })

  test("unrecognized / too-short → null", () => {
    expect(imageDimensions(new Uint8Array([1, 2]))).toBeNull() // too short
    expect(imageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull() // no magic
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0x00, 0x01]))).toBeNull() // JPEG SOI but misaligned
    expect(imageDimensions(webpHeader("XXXX", new Uint8Array(20)))).toBeNull() // unknown WebP chunk
  })
})

describe("readImageDimensions", () => {
  test("reads from a Blob-like source (Bun.file / fetch)", async () => {
    const blob = new Blob([PNG_1x1])
    expect(await readImageDimensions(blob)).toEqual({ width: 1, height: 1, format: "png" })
  })

  test("truncates to maxBytes (header is enough)", async () => {
    expect(await readImageDimensions(new Blob([gif(7, 9)]), 10)).toEqual({
      width: 7,
      height: 9,
      format: "gif",
    })
  })

  test("reads at most maxBytes from streaming sources and cancels the rest", async () => {
    let cancelled = false
    const source = {
      arrayBuffer: async () => {
        throw new Error("arrayBuffer should not be used when stream() exists")
      },
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([...PNG_1x1, ...new Uint8Array(1024)]))
          },
          cancel() {
            cancelled = true
          },
        }),
    }

    expect(await readImageDimensions(source, 24)).toEqual({ width: 1, height: 1, format: "png" })
    expect(cancelled).toBe(true)
  })

  test("cancels a streaming source when it reads exactly maxBytes before EOF", async () => {
    let cancelled = false
    const source = {
      arrayBuffer: async () => {
        throw new Error("arrayBuffer should not be used when stream() exists")
      },
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PNG_1x1.subarray(0, 24))
          },
          cancel() {
            cancelled = true
          },
        }),
    }

    expect(await readImageDimensions(source, 24)).toEqual({ width: 1, height: 1, format: "png" })
    expect(cancelled).toBe(true)
  })

  test("validates maxBytes", async () => {
    await expect(readImageDimensions(new Blob([PNG_1x1]), 0)).rejects.toThrow(/maxBytes/)
  })
})
