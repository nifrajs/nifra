import { type ImageInfo, imageDimensions, tiffOrientation } from "./dimensions.ts"

/** Full-file build probe: container EXIF may live after the compressed pixels. */
export function imageBuildMetadata(bytes: Uint8Array): {
  info: ImageInfo | null
  animated: boolean
} {
  const info = imageDimensions(bytes)
  if (info === null) return { info, animated: false }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kind = (offset: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4))
  let orientation = 1
  let animated = info.format === "gif"
  if (info.format === "png") {
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const size = view.getUint32(offset)
      const end = offset + 12 + size
      if (end > bytes.length) break
      const type = kind(offset + 4)
      if (type === "eXIf") orientation = tiffOrientation(bytes, offset + 8, end - 4)
      if (type === "acTL") animated = true
      if (type === "IEND") break
      offset = end
    }
  } else if (info.format === "webp") {
    const limit = Math.min(bytes.length, 8 + view.getUint32(4, true))
    for (let offset = 12; offset + 8 <= limit; ) {
      const size = view.getUint32(offset + 4, true)
      const start = offset + 8
      const end = start + size
      if (end > limit) break
      const type = kind(offset)
      if (type === "EXIF") {
        const prefix = [0x45, 0x78, 0x69, 0x66, 0, 0]
        const tiff = prefix.every((byte, i) => bytes[start + i] === byte) ? start + 6 : start
        orientation = tiffOrientation(bytes, tiff, end)
      }
      if (
        (type === "VP8X" && size >= 1 && ((bytes[start] ?? 0) & 2) !== 0) ||
        type === "ANIM" ||
        type === "ANMF"
      )
        animated = true
      offset = end + (size & 1)
    }
  }
  return {
    info: orientation >= 5 ? { ...info, width: info.height, height: info.width } : info,
    animated,
  }
}
