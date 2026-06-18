/**
 * Read an image's intrinsic dimensions from its file **header**, in pure JS — no decode, no codec, no
 * dependency. Supports PNG, JPEG, GIF, and WebP (VP8/VP8L/VP8X). Used to give `<Image>` CLS-safe
 * `width`/`height` (build-time tooling can pre-read them into a manifest).
 */
export type ImageFormat = "png" | "jpeg" | "gif" | "webp"

export interface ImageInfo {
  readonly width: number
  readonly height: number
  readonly format: ImageFormat
}

const png = (b: Uint8Array, dv: DataView): ImageInfo | null => {
  // 8-byte signature, then IHDR (length+type), then width/height as big-endian uint32 @16/@20.
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null
  return { width: dv.getUint32(16), height: dv.getUint32(20), format: "png" }
}

const gif = (b: Uint8Array, dv: DataView): ImageInfo | null => {
  // 'GIF', then the logical-screen width/height as little-endian uint16 @6/@8.
  if (b.length < 10 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null
  return { width: dv.getUint16(6, true), height: dv.getUint16(8, true), format: "gif" }
}

const jpeg = (b: Uint8Array, dv: DataView): ImageInfo | null => {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < b.length) {
    if (dv.getUint8(offset) !== 0xff) return null // not aligned on a marker → malformed
    const marker = dv.getUint8(offset + 1)
    // SOF0..SOF15 carry the frame's height/width — except DHT(c4)/DNL(c8)/DAC(cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: dv.getUint16(offset + 5), width: dv.getUint16(offset + 7), format: "jpeg" }
    }
    offset += 2 + dv.getUint16(offset + 2) // skip this segment (2-byte marker + segment length)
  }
  return null
}

const webp = (b: Uint8Array, dv: DataView): ImageInfo | null => {
  // 'RIFF' .... 'WEBP' then a VP8 / VP8L / VP8X chunk.
  if (b.length < 30 || b[0] !== 0x52 || b[1] !== 0x49 || b[8] !== 0x57 || b[9] !== 0x45) return null
  const chunk = String.fromCharCode(
    b[12] as number,
    b[13] as number,
    b[14] as number,
    b[15] as number,
  )
  if (chunk === "VP8 ") {
    // lossy: 14-bit width/height (little-endian) at @26/@28, masked to 14 bits.
    return {
      width: dv.getUint16(26, true) & 0x3fff,
      height: dv.getUint16(28, true) & 0x3fff,
      format: "webp",
    }
  }
  if (chunk === "VP8L") {
    // lossless: after the 0x2f signature @20, 14-bit (width-1) then 14-bit (height-1), bit-packed LE.
    if (b[20] !== 0x2f) return null
    const bits = dv.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp" }
  }
  if (chunk === "VP8X") {
    // extended: 24-bit (width-1) then 24-bit (height-1), little-endian, at @24/@27.
    const w = (b[24] as number) | ((b[25] as number) << 8) | ((b[26] as number) << 16)
    const h = (b[27] as number) | ((b[28] as number) << 8) | ((b[29] as number) << 16)
    return { width: w + 1, height: h + 1, format: "webp" }
  }
  return null
}

/** Parse intrinsic dimensions + format from image header bytes, or `null` if unrecognized/too short. */
export function imageDimensions(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 4) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return png(bytes, dv) ?? gif(bytes, dv) ?? jpeg(bytes, dv) ?? webp(bytes, dv)
}

/**
 * Read just the leading bytes of an image file (via the platform `Bun.file`/`fetch` blob) and parse its
 * dimensions. Build-time tooling: pre-read dimensions into a manifest so `<Image>` is CLS-safe without
 * hardcoding sizes. Reads at most `maxBytes` (default 64 KB — enough for any header).
 */
export async function readImageDimensions(
  source: { arrayBuffer(): Promise<ArrayBuffer>; stream?: () => ReadableStream<Uint8Array> },
  maxBytes = 65_536,
): Promise<ImageInfo | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("[nifra/image] readImageDimensions: maxBytes must be a positive safe integer")
  }
  if (source.stream !== undefined) {
    const reader = source.stream().getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let reachedEof = false
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read()
        if (done) {
          reachedEof = true
          break
        }
        const remaining = maxBytes - total
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
        chunks.push(chunk)
        total += chunk.byteLength
        if (value.byteLength > remaining) {
          await reader.cancel()
          reachedEof = true
          break
        }
      }
      if (!reachedEof) await reader.cancel()
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return imageDimensions(bytes)
  }
  const buf = await source.arrayBuffer()
  const bytes = new Uint8Array(buf)
  return imageDimensions(bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes)
}
