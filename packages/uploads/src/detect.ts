/**
 * Magic-byte file-type detection — trust the bytes, not the `Content-Type` header (which a client
 * sets freely). Reads only the leading bytes; dependency-free + edge-safe. Covers the common upload
 * types; returns `null` for anything unrecognized (incl. text formats like SVG/CSV that have no magic
 * number — handle those explicitly if you accept them).
 */

export interface FileType {
  /** Detected MIME type, e.g. `"image/png"`. */
  readonly mime: string
  /** Canonical extension (no dot), e.g. `"png"`. */
  readonly ext: string
}

/** Detect a file's type from its magic bytes, or `null` if unrecognized. */
export function detectFileType(bytes: Uint8Array): FileType | null {
  const at = (offset: number, ...sig: number[]): boolean =>
    sig.every((byte, i) => bytes[offset + i] === byte)

  // Images
  if (at(0, 0xff, 0xd8, 0xff)) return { mime: "image/jpeg", ext: "jpg" }
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return { mime: "image/png", ext: "png" }
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return { mime: "image/gif", ext: "gif" }

  // RIFF container (bytes 0–3 "RIFF", 8–11 the form type)
  if (at(0, 0x52, 0x49, 0x46, 0x46)) {
    if (at(8, 0x57, 0x45, 0x42, 0x50)) return { mime: "image/webp", ext: "webp" }
    if (at(8, 0x57, 0x41, 0x56, 0x45)) return { mime: "audio/wav", ext: "wav" }
    if (at(8, 0x41, 0x56, 0x49, 0x20)) return { mime: "video/x-msvideo", ext: "avi" }
  }

  // ISO-BMFF (`ftyp` box at offset 4) — mp4 / avif / heic / m4a, disambiguated by the major brand.
  if (at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0)
    if (brand === "avif" || brand === "avis") return { mime: "image/avif", ext: "avif" }
    if (brand.startsWith("hei") || brand === "mif1") return { mime: "image/heic", ext: "heic" }
    // Audio brands share the ISO-BMFF container but are NOT video — labeling them `video/mp4` would
    // both reject real audio under an `audio/*` allow-list and admit it under `video/*`. `M4A `/`M4B `
    // are AAC audio / audiobooks.
    if (brand === "M4A " || brand === "M4B ") return { mime: "audio/mp4", ext: "m4a" }
    return { mime: "video/mp4", ext: "mp4" }
  }

  // A/V + archives
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return { mime: "video/webm", ext: "webm" } // Matroska/WebM
  if (at(0, 0x4f, 0x67, 0x67, 0x53)) return { mime: "audio/ogg", ext: "ogg" }
  if (at(0, 0x49, 0x44, 0x33)) return { mime: "audio/mpeg", ext: "mp3" } // ID3 tag
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return { mime: "application/pdf", ext: "pdf" } // "%PDF"
  if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x50, 0x4b, 0x05, 0x06)) {
    return { mime: "application/zip", ext: "zip" } // also docx/xlsx/odt containers
  }
  if (at(0, 0x1f, 0x8b)) return { mime: "application/gzip", ext: "gz" }

  return null
}
