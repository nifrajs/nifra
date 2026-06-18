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
    expect(calls.resize).toEqual([{ width: 150, withoutEnlargement: true }])
    expect(calls.encode).toEqual(["webp"])
    expect(out.contentType).toBe("image/webp")
    expect(new TextDecoder().decode(out.bytes)).toBe("<<webp>>")
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
 * `imageDimensions` reads. No pixel data — exactly the bomb-safe, header-only probe path. */
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
