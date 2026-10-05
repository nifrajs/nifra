import { describe, expect, test } from "bun:test"
import {
  type DecodedImage,
  ImageProcessingError,
  type SharpLike,
  sharpImageBackend,
  type WasmImageCodecs,
  wasmImageBackend,
} from "@nifrajs/image/backends"

// --- sharp backend (stubbed sharp) -------------------------------------------------------------------

function stubSharp(over: { metadata?: unknown; toBufferError?: unknown } = {}): {
  sharp: SharpLike
  calls: { resize: unknown[]; encode: string[] }
} {
  const calls = { resize: [] as unknown[], encode: [] as string[] }
  const sharp: SharpLike = () => {
    let fmt = "png"
    const inst = {
      metadata: async () => (over.metadata ?? { width: 200, height: 100, format: "jpeg" }) as never,
      rotate() {
        calls.resize.push("rotate")
        return inst
      },
      resize(o: { width: number; withoutEnlargement?: boolean }) {
        calls.resize.push(o)
        return inst
      },
      webp(_o: { quality: number }) {
        fmt = "webp"
        calls.encode.push("webp")
        return inst
      },
      jpeg(_o: { quality: number }) {
        fmt = "jpeg"
        calls.encode.push("jpeg")
        return inst
      },
      png() {
        fmt = "png"
        calls.encode.push("png")
        return inst
      },
      toBuffer: async () => {
        if (over.toBufferError !== undefined) throw over.toBufferError
        return new TextEncoder().encode(`<<${fmt}>>`)
      },
    }
    return inst
  }
  return { sharp, calls }
}

describe("sharpImageBackend", () => {
  test("probe reads dimensions + format from sharp metadata", async () => {
    const { sharp } = stubSharp()
    expect(await sharpImageBackend(sharp).probe(new Uint8Array())).toEqual({
      width: 200,
      height: 100,
      format: "jpeg",
    })
  })

  test("transform resizes (no enlargement) + encodes to the requested format", async () => {
    const { sharp, calls } = stubSharp()
    const out = await sharpImageBackend(sharp).transform({
      bytes: new Uint8Array(),
      width: 150,
      quality: 80,
      format: "webp",
    })
    // Upright by EXIF first, so the encoded image (which drops the tag) displays the same way.
    expect(calls.resize).toEqual(["rotate", { width: 150, withoutEnlargement: true }])
    expect(calls.encode).toEqual(["webp"])
    expect(out.contentType).toBe("image/webp")
    expect(new TextDecoder().decode(out.bytes)).toBe("<<webp>>")
  })

  test("probe reports the displayed size of a quarter-turned photo", async () => {
    const { sharp } = stubSharp({
      metadata: { width: 400, height: 300, format: "jpeg", orientation: 6 },
    })
    expect(await sharpImageBackend(sharp).probe(new Uint8Array())).toEqual({
      width: 300,
      height: 400,
      format: "jpeg",
    })
  })

  test("probe throws decode when sharp can't read dimensions", async () => {
    const { sharp } = stubSharp({ metadata: { format: "jpeg" } }) // no width/height
    await expect(sharpImageBackend(sharp).probe(new Uint8Array())).rejects.toBeInstanceOf(
      ImageProcessingError,
    )
  })

  test("maps a sharp pixel-limit error to 'too_large'", async () => {
    const { sharp } = stubSharp({ toBufferError: new Error("Input image exceeds pixel limit") })
    try {
      await sharpImageBackend(sharp).transform({
        bytes: new Uint8Array(),
        width: 10,
        quality: 75,
        format: "png",
      })
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(ImageProcessingError)
      expect((err as ImageProcessingError).kind).toBe("too_large")
    }
  })
})

// --- WASM backend (stubbed codecs, real PNG header for probe) ----------------------------------------

/** A minimal PNG header: 8-byte signature + IHDR with width@16 / height@20 (big-endian), which is all
 * `imageDimensions` reads. No pixel data - exactly the bomb-safe, header-only probe path. */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) // PNG signature
  b.set([0, 0, 0, 13], 8) // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
  const dv = new DataView(b.buffer)
  dv.setUint32(16, width)
  dv.setUint32(20, height)
  return b
}

function stubCodecs(over: { decodeError?: unknown } = {}): {
  codecs: WasmImageCodecs
  calls: { decode: number; resize: Array<[number, number]>; encode: string[] }
} {
  const calls = { decode: 0, resize: [] as Array<[number, number]>, encode: [] as string[] }
  const rgba = (w: number, h: number): DecodedImage => ({
    data: new Uint8Array(w * h * 4),
    width: w,
    height: h,
  })
  const codecs: WasmImageCodecs = {
    decode() {
      calls.decode++
      if (over.decodeError !== undefined) throw over.decodeError
      return rgba(200, 100)
    },
    resize(_img, width, height) {
      calls.resize.push([width, height])
      return rgba(width, height)
    },
    encode(_img, format) {
      calls.encode.push(format)
      return new TextEncoder().encode(`<<${format}>>`)
    },
  }
  return { codecs, calls }
}

describe("wasmImageBackend", () => {
  test("probe reads the header only (never decodes)", async () => {
    const { codecs, calls } = stubCodecs()
    const probe = await wasmImageBackend(codecs).probe(pngHeader(640, 480))
    expect(probe).toEqual({ width: 640, height: 480, format: "png" })
    expect(calls.decode).toBe(0) // bomb-safe: no decode in probe
  })

  test("probe throws decode on an unrecognized header", async () => {
    const { codecs } = stubCodecs()
    await expect(
      wasmImageBackend(codecs).probe(new Uint8Array([1, 2, 3, 4])),
    ).rejects.toBeInstanceOf(ImageProcessingError)
  })

  test("transform decodes → resizes (aspect-preserving) → encodes", async () => {
    const { codecs, calls } = stubCodecs() // decode yields 200x100
    const out = await wasmImageBackend(codecs).transform({
      bytes: new Uint8Array(),
      width: 100,
      quality: 80,
      format: "webp",
    })
    expect(calls.decode).toBe(1)
    expect(calls.resize).toEqual([[100, 50]]) // height scaled to keep 2:1 aspect
    expect(calls.encode).toEqual(["webp"])
    expect(out.contentType).toBe("image/webp")
  })

  test("transform skips resize when the width already matches the source", async () => {
    const { codecs, calls } = stubCodecs() // 200 wide
    await wasmImageBackend(codecs).transform({
      bytes: new Uint8Array(),
      width: 200,
      quality: 75,
      format: "png",
    })
    expect(calls.resize).toEqual([]) // no-op resize avoided
    expect(calls.encode).toEqual(["png"])
  })

  test("maps a codec failure to ImageProcessingError", async () => {
    const { codecs } = stubCodecs({ decodeError: new Error("corrupt") })
    await expect(
      wasmImageBackend(codecs).transform({
        bytes: new Uint8Array(),
        width: 10,
        quality: 75,
        format: "png",
      }),
    ).rejects.toBeInstanceOf(ImageProcessingError)
  })
})

/** A JPEG header: an APP1 EXIF block declaring `orientation`, then a SOF0 for a `width`x`height` frame. */
function exifJpeg(orientation: number, width: number, height: number): Uint8Array {
  const tiff = [
    0x4d,
    0x4d,
    0,
    42,
    0,
    0,
    0,
    8,
    0,
    1,
    0x01,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    orientation,
    0,
    0,
  ]
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff, 0, 0, 0, 0]
  const sof = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3]
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    0,
    app1.length + 2,
    ...app1,
    ...sof,
    ...new Array<number>(9).fill(0),
  ])
}

describe("wasmImageBackend turns a JPEG upright by its EXIF orientation", () => {
  // Stored 3 wide x 2 high, each pixel's red channel its label.
  const STORED = [1, 2, 3, 4, 5, 6]
  // What a viewer shows for each orientation (rows top to bottom), per the EXIF definitions.
  const SHOWN: Record<number, number[][]> = {
    1: [
      [1, 2, 3],
      [4, 5, 6],
    ],
    2: [
      [3, 2, 1],
      [6, 5, 4],
    ],
    3: [
      [6, 5, 4],
      [3, 2, 1],
    ],
    4: [
      [4, 5, 6],
      [1, 2, 3],
    ],
    5: [
      [1, 4],
      [2, 5],
      [3, 6],
    ],
    6: [
      [4, 1],
      [5, 2],
      [6, 3],
    ],
    7: [
      [6, 3],
      [5, 2],
      [4, 1],
    ],
    8: [
      [3, 6],
      [2, 5],
      [1, 4],
    ],
  }

  const encodedFrom = async (orientation: number, decoded: DecodedImage): Promise<DecodedImage> => {
    let encoded: DecodedImage | undefined
    const codecs: WasmImageCodecs = {
      decode: () => decoded,
      resize: (image) => image,
      encode(image) {
        encoded = image
        return new Uint8Array()
      },
    }
    const backend = wasmImageBackend(codecs)
    const bytes = exifJpeg(orientation, 3, 2)
    const { width } = await backend.probe(bytes)
    await backend.transform({ bytes, width, quality: 80, format: "png" })
    if (encoded === undefined) throw new Error("nothing was encoded")
    return encoded
  }

  test.each([1, 2, 3, 4, 5, 6, 7, 8])("orientation %d", async (orientation) => {
    const data = new Uint8Array(STORED.flatMap((label) => [label, 0, 0, 255]))
    const image = await encodedFrom(orientation, { data, width: 3, height: 2 })
    const rows = SHOWN[orientation] ?? []
    expect({ width: image.width, height: image.height }).toEqual({
      width: rows[0]?.length ?? 0,
      height: rows.length,
    })
    expect([...image.data].filter((_, i) => i % 4 === 0)).toEqual(rows.flat())
  })

  test("a codec that already turned the pixels is left as it is", async () => {
    const data = new Uint8Array([4, 1, 5, 2, 6, 3].flatMap((label) => [label, 0, 0, 255]))
    const image = await encodedFrom(6, { data, width: 2, height: 3 })
    expect([...image.data].filter((_, i) => i % 4 === 0)).toEqual([4, 1, 5, 2, 6, 3])
  })
})
