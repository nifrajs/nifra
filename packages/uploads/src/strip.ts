/**
 * Strip EXIF/GPS/metadata from an uploaded image by **re-encoding** it - decoders don't carry
 * embedded metadata through, so a decode→encode round-trip drops it (and normalizes the format).
 *
 * Backend-agnostic: pass any `@nifrajs/image` backend (`bunImageBackend`, `sharpImageBackend`,
 * `wasmImageBackend`) - the structural type below matches them, so this package takes **no** dependency
 * on `@nifrajs/image`. Run server-side (the codecs are Node/Bun-only); validate the upload first
 * (`validateUpload`) so you only re-encode real images.
 */

type StripFormat = "webp" | "jpeg" | "png"

/** The slice of `@nifrajs/image`'s `ImageBackend` this needs - `probe` for dims/format, `transform` to re-encode. */
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
  /** Encode quality (1-100). Default 82. */
  readonly quality?: number
  /**
   * Largest source (width x height) the backend may decode. A few hundred compressed bytes can
   * declare a picture that decodes to gigabytes, so this is checked against the probed header
   * before any decode. Default 40 MP, the same as `@nifrajs/image`'s `createImageHandler`.
   */
  readonly maxPixels?: number
}

const DEFAULT_MAX_PIXELS = 40_000_000

/** Thrown before decoding a source larger than `maxPixels`; answer it with a `413`. */
export class ImagePixelLimitError extends Error {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly maxPixels: number,
  ) {
    super(`stripImageMetadata: a ${width}x${height} image exceeds maxPixels (${maxPixels})`)
    this.name = "ImagePixelLimitError"
  }
}

/**
 * Re-encode an image to its intrinsic size, dropping all embedded metadata. Returns clean bytes.
 * A source over `maxPixels` throws {@link ImagePixelLimitError} without being decoded. Each call
 * holds a full decoded image in memory, so bound how many run at once where uploads arrive.
 */
export async function stripImageMetadata(
  bytes: Uint8Array,
  backend: ImageReencoder,
  options: StripImageMetadataOptions = {},
): Promise<Uint8Array> {
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1)
    throw new RangeError("stripImageMetadata: maxPixels must be a positive safe integer")
  const probed = await backend.probe(bytes)
  if (
    !Number.isSafeInteger(probed.width) ||
    !Number.isSafeInteger(probed.height) ||
    probed.width < 1 ||
    probed.height < 1
  )
    throw new TypeError("stripImageMetadata: the backend probed invalid image dimensions")
  if (probed.width * probed.height > maxPixels)
    throw new ImagePixelLimitError(probed.width, probed.height, maxPixels)
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
