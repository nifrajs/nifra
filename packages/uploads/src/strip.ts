/**
 * Strip EXIF/GPS/metadata from an uploaded image by **re-encoding** it — decoders don't carry
 * embedded metadata through, so a decode→encode round-trip drops it (and normalizes the format).
 *
 * Backend-agnostic: pass any `@nifrajs/image` backend (`bunImageBackend`, `sharpImageBackend`,
 * `wasmImageBackend`) — the structural type below matches them, so this package takes **no** dependency
 * on `@nifrajs/image`. Run server-side (the codecs are Node/Bun-only); validate the upload first
 * (`validateUpload`) so you only re-encode real images.
 */

type StripFormat = "webp" | "jpeg" | "png"

/** The slice of `@nifrajs/image`'s `ImageBackend` this needs — `probe` for dims/format, `transform` to re-encode. */
export interface ImageReencoder {
  probe(
    bytes: Uint8Array,
  ): Promise<{ readonly width: number; readonly height: number; readonly format: string }>
  transform(input: {
    readonly bytes: Uint8Array
    readonly width: number
    readonly quality: number
    readonly format: StripFormat
  }): Promise<{ readonly bytes: Uint8Array }>
}

export interface StripImageMetadataOptions {
  /** Output format. Default: keep png/jpeg, else re-encode to webp. */
  readonly format?: StripFormat
  /** Encode quality (1–100). Default 82. */
  readonly quality?: number
}

/** Re-encode an image to its intrinsic size, dropping all embedded metadata. Returns clean bytes. */
export async function stripImageMetadata(
  bytes: Uint8Array,
  backend: ImageReencoder,
  options: StripImageMetadataOptions = {},
): Promise<Uint8Array> {
  const probed = await backend.probe(bytes)
  const format: StripFormat =
    options.format ?? (probed.format === "png" ? "png" : probed.format === "jpeg" ? "jpeg" : "webp")
  const out = await backend.transform({
    bytes,
    width: probed.width,
    quality: options.quality ?? 82,
    format,
  })
  return out.bytes
}
