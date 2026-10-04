/**
 * Read an image's intrinsic dimensions from its file **header**, in pure JS - no decode, no codec, no
 * dependency. Supports PNG, JPEG, GIF, and WebP (VP8/VP8L/VP8X). Used to give `<Image>` CLS-safe
 * `width`/`height` (build-time tooling can pre-read them into a manifest). A JPEG's are the size it is
 * displayed at: its EXIF orientation applied, as a browser applies it.
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

/** The EXIF orientation (1-8) an APP1 segment's TIFF block declares, read within `[start, end)`. */
const exifOrientation = (b: Uint8Array, dv: DataView, start: number, end: number): number => {
  // "Exif\0\0", then a TIFF header: byte order ("II" little / "MM" big), 42, IFD0's offset.
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0]
  if (start + 14 > end || exif.some((byte, i) => b[start + i] !== byte)) return 1
  const tiff = start + 6
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return 1
  if (dv.getUint16(tiff + 2, little) !== 42) return 1
  const ifd = tiff + dv.getUint32(tiff + 4, little)
  if (ifd + 2 > end) return 1
  for (let i = 0, count = dv.getUint16(ifd, little); i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) return 1
    if (dv.getUint16(entry, little) !== 0x0112) continue
    const orientation = dv.getUint16(entry + 8, little)
    return orientation >= 1 && orientation <= 8 ? orientation : 1
  }
  return 1
}

/** A JPEG's stored frame size and its EXIF orientation, from the segments before the frame. */
const jpegFrame = (
  b: Uint8Array,
  dv: DataView,
): { width: number; height: number; orientation: number } | null => {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let offset = 2
  let orientation = 1
  while (offset + 9 < b.length) {
    if (dv.getUint8(offset) !== 0xff) return null // not aligned on a marker → malformed
    const marker = dv.getUint8(offset + 1)
    // SOF0..SOF15 carry the frame's height/width - except DHT(c4)/DNL(c8)/DAC(cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: dv.getUint16(offset + 5), width: dv.getUint16(offset + 7), orientation }
    }
    const next = offset + 2 + dv.getUint16(offset + 2) // skip this segment (2-byte marker + length)
    if (marker === 0xe1 && orientation === 1) {
      orientation = exifOrientation(b, dv, offset + 4, Math.min(next, b.length))
    }
    offset = next
  }
  return null
}

const jpeg = (b: Uint8Array, dv: DataView): ImageInfo | null => {
  const frame = jpegFrame(b, dv)
  if (frame === null) return null
  // A browser draws a JPEG turned by its EXIF orientation, and 5-8 turn it a quarter: the sides swap.
  return frame.orientation >= 5
    ? { width: frame.height, height: frame.width, format: "jpeg" }
    : { width: frame.width, height: frame.height, format: "jpeg" }
}

/**
 * The EXIF orientation (1-8) a JPEG declares - how its stored pixels are turned for display - or `1`
 * for upright, for another format, or for an unreadable header.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4) return 1
  return (
    jpegFrame(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength))?.orientation ??
    1
  )
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
 * hardcoding sizes. Reads at most `maxBytes` (default 64 KB - enough for any header).
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
