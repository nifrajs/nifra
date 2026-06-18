/**
 * `@nifrajs/image/backends` — the codec seam + the official {@link ImageBackend} implementations, kept
 * **dependency-free and edge-safe** (no `node:` imports), so the WASM backend can run on Workers /
 * Vercel-Edge / Deno-Deploy. `createImageHandler` (in `@nifrajs/image/server`, Node-only — it touches the
 * filesystem) consumes this seam and owns all request-level security; a backend only
 * decodes/resizes/encodes and translates codec failures into {@link ImageProcessingError}.
 *
 * Pick a backend for your runtime:
 * - {@link bunImageBackend} — `Bun.Image` (libjpeg-turbo / libspng / libwebp). Bun servers.
 * - {@link sharpImageBackend} — pass your `sharp` import. Node servers.
 * - {@link wasmImageBackend} — pass WASM codecs (e.g. jSquash). Any runtime, including the edge.
 */

import { imageDimensions } from "./dimensions.ts"

/** Output formats nifra's endpoint can emit. AVIF is intentionally excluded — `Bun.Image` reports
 * `ERR_IMAGE_FORMAT_UNSUPPORTED` for AVIF encode on common platforms, so offering it would 500. */
export type OutputFormat = "webp" | "jpeg" | "png"

export const CONTENT_TYPE: Record<OutputFormat, string> = {
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
}

/** Header-only probe of a source image: intrinsic dimensions + decoded format. Must be cheap (no full
 * decode) — it gates the decompression-bomb and no-upscale checks before the expensive resize. */
export interface ImageProbe {
  readonly width: number
  readonly height: number
  /** Lowercased source format as the codec sees it (`"png"`, `"jpeg"`, `"webp"`, `"gif"`, …). */
  readonly format: string
}

export interface ResizeInput {
  readonly bytes: Uint8Array
  /** Target width in px — already clamped to `[1, maxWidth]` **and** to the source's intrinsic width
   * (the handler never asks a backend to upscale). Aspect ratio is preserved. */
  readonly width: number
  /** Encoder quality `1..100` (ignored for lossless `png`). */
  readonly quality: number
  readonly format: OutputFormat
}

export interface ResizeOutput {
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly format: OutputFormat
}

/**
 * The codec seam. The handler owns all request-level security (validation, SSRF, byte/pixel caps,
 * concurrency, caching); a backend only decodes/resizes/encodes. Backends MUST translate codec failures
 * into {@link ImageProcessingError} so the handler can map them to stable HTTP statuses.
 */
export interface ImageBackend {
  /** Cheap, header-only metadata read. Throws {@link ImageProcessingError} (`decode` / `too_large`). */
  probe(bytes: Uint8Array): Promise<ImageProbe>
  /** Decode → resize to `input.width` (aspect-preserving) → encode to `input.format`. */
  transform(input: ResizeInput): Promise<ResizeOutput>
}

/** Normalized, backend-agnostic processing failure. Lets the handler map codec errors to HTTP status
 * without coupling to any one codec's error codes. */
export class ImageProcessingError extends Error {
  constructor(
    readonly kind: "decode" | "too_large" | "unsupported",
    message: string,
  ) {
    super(message)
    this.name = "ImageProcessingError"
  }
}

// --- Bun.Image backend -------------------------------------------------------------------------------

/** Minimal structural type for the `Bun.Image` surface this backend uses (avoids a hard Bun type dep). */
interface BunImageCtor {
  new (
    input: Uint8Array,
  ): {
    metadata(): Promise<{ width: number; height: number; format: string }>
    resize(width: number): BunImageChain
  }
}
interface BunImageChain {
  webp(opts: { quality: number }): { bytes(): Promise<Uint8Array> }
  jpeg(opts: { quality: number }): { bytes(): Promise<Uint8Array> }
  png(): { bytes(): Promise<Uint8Array> }
}

/**
 * {@link ImageBackend} backed by `Bun.Image` (libjpeg-turbo / libspng / libwebp, decoded off the main
 * thread). Requires the Bun runtime. The default backend of `createImageHandler`.
 */
export function bunImageBackend(): ImageBackend {
  if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
    throw new Error("[nifra/image] bunImageBackend() requires the Bun runtime")
  }
  const Image = (globalThis as unknown as { Bun: { Image: BunImageCtor } }).Bun.Image
  return {
    async probe(bytes) {
      try {
        const md = await new Image(bytes).metadata()
        return { width: md.width, height: md.height, format: String(md.format).toLowerCase() }
      } catch (err) {
        throw toBunError(err)
      }
    },
    async transform({ bytes, width, quality, format }) {
      try {
        const img = new Image(bytes).resize(width)
        const encoded =
          format === "webp"
            ? img.webp({ quality })
            : format === "jpeg"
              ? img.jpeg({ quality })
              : img.png()
        const out = await encoded.bytes()
        return { bytes: out, contentType: CONTENT_TYPE[format], format }
      } catch (err) {
        throw toBunError(err)
      }
    },
  }
}

/** Map a `Bun.Image` failure to a normalized {@link ImageProcessingError}. */
function toBunError(err: unknown): ImageProcessingError {
  if (err instanceof ImageProcessingError) return err
  const code = (err as { code?: string } | null)?.code ?? ""
  if (code === "ERR_IMAGE_TOO_MANY_PIXELS") {
    return new ImageProcessingError("too_large", "source image exceeds the codec pixel limit")
  }
  if (code === "ERR_IMAGE_FORMAT_UNSUPPORTED") {
    return new ImageProcessingError("unsupported", "image format not supported by the codec")
  }
  return new ImageProcessingError("decode", "source is not a decodable image")
}

// --- sharp backend (Node) ----------------------------------------------------------------------------

/** The slice of a [sharp](https://sharp.pixelplumbing.com) instance this backend uses. Declared
 * structurally so `@nifrajs/image` has no dependency on sharp — pass your own `sharp` import. */
export type SharpLike = (input: Uint8Array) => SharpInstance
interface SharpInstance {
  metadata(): Promise<{ width?: number; height?: number; format?: string }>
  resize(options: { width: number; withoutEnlargement?: boolean }): SharpInstance
  webp(options: { quality: number }): SharpInstance
  jpeg(options: { quality: number }): SharpInstance
  png(): SharpInstance
  toBuffer(): Promise<Uint8Array>
}

/**
 * {@link ImageBackend} backed by [sharp](https://sharp.pixelplumbing.com) (libvips) for Node servers.
 * Pass your `sharp` import — `@nifrajs/image` never imports it, so it stays dependency-free and you control
 * the version:
 *
 * ```ts
 * import sharp from "sharp"
 * createImageHandler({ backend: sharpImageBackend(sharp), root: "./public" })
 * ```
 */
export function sharpImageBackend(sharp: SharpLike): ImageBackend {
  return {
    async probe(bytes) {
      try {
        const md = await sharp(bytes).metadata()
        if (md.width === undefined || md.height === undefined) {
          throw new ImageProcessingError("decode", "sharp could not read image dimensions")
        }
        return { width: md.width, height: md.height, format: String(md.format ?? "").toLowerCase() }
      } catch (err) {
        throw toSharpError(err)
      }
    },
    async transform({ bytes, width, quality, format }) {
      try {
        // `withoutEnlargement` is belt-and-braces: the handler already clamps width ≤ intrinsic.
        const pipeline = sharp(bytes).resize({ width, withoutEnlargement: true })
        const encoded =
          format === "webp"
            ? pipeline.webp({ quality })
            : format === "jpeg"
              ? pipeline.jpeg({ quality })
              : pipeline.png()
        return { bytes: await encoded.toBuffer(), contentType: CONTENT_TYPE[format], format }
      } catch (err) {
        throw toSharpError(err)
      }
    },
  }
}

/** Map a sharp failure to a normalized {@link ImageProcessingError} by its message. */
function toSharpError(err: unknown): ImageProcessingError {
  if (err instanceof ImageProcessingError) return err
  const message = (err instanceof Error ? err.message : "").toLowerCase()
  if (message.includes("pixel limit") || message.includes("too large")) {
    return new ImageProcessingError("too_large", "source image exceeds sharp's pixel limit")
  }
  if (message.includes("unsupported image format") || message.includes("bad seek")) {
    return new ImageProcessingError("decode", "sharp could not decode the source image")
  }
  return new ImageProcessingError("decode", "sharp failed to process the image")
}

// --- WASM backend (edge-portable) --------------------------------------------------------------------

/** A decoded image: RGBA pixels + dimensions — the lingua franca of WASM codecs (jSquash, Photon, …). */
export interface DecodedImage {
  /** RGBA bytes, length `width * height * 4`. */
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

/**
 * Pluggable WASM codec set — decode/resize/encode. Declared structurally so `@nifrajs/image` depends on no
 * WASM library; wire your own (jSquash is the common pure-WASM, edge-safe choice). The handler probes
 * dimensions from the source header (bomb-safe), so `decode` runs only inside `transform`.
 */
export interface WasmImageCodecs {
  /** Decode any supported encoded image → RGBA. Throw on undecodable input. */
  decode(bytes: Uint8Array): Promise<DecodedImage> | DecodedImage
  /** Resize RGBA to the target dimensions (the handler keeps the aspect ratio). */
  resize(image: DecodedImage, width: number, height: number): Promise<DecodedImage> | DecodedImage
  /** Encode RGBA → the target format's bytes. */
  encode(
    image: DecodedImage,
    format: OutputFormat,
    quality: number,
  ): Promise<Uint8Array> | Uint8Array
}

/**
 * {@link ImageBackend} backed by injected WASM codecs — the only backend that runs on the **edge**
 * (Workers / Vercel-Edge / Deno-Deploy), where neither `Bun.Image` nor sharp exists. `probe` reads the
 * source header via nifra's dependency-free reader (so decompression bombs are rejected before any
 * decode); `transform` decodes → resizes (aspect-preserving) → encodes through your codecs.
 *
 * ```ts
 * import decode from "@jsquash/jpeg/decode"; import resize from "@jsquash/resize"
 * import encodeWebp from "@jsquash/webp/encode" // …+ png/jpeg encoders
 * const backend = wasmImageBackend({ decode, resize: (img, w, h) => resize(img, { width: w, height: h }), encode })
 * ```
 */
export function wasmImageBackend(codecs: WasmImageCodecs): ImageBackend {
  return {
    async probe(bytes) {
      const info = imageDimensions(bytes) // header-only — never allocates a decoded buffer
      if (info === null) {
        throw new ImageProcessingError("decode", "unrecognized image header")
      }
      return { width: info.width, height: info.height, format: info.format }
    },
    async transform({ bytes, width, quality, format }) {
      try {
        const decoded = await codecs.decode(bytes)
        // Aspect-preserving: the handler hands a width already clamped to the intrinsic width.
        const height = Math.max(1, Math.round((decoded.height * width) / decoded.width))
        const resized =
          width === decoded.width ? decoded : await codecs.resize(decoded, width, height)
        const out = await codecs.encode(resized, format, quality)
        return { bytes: out, contentType: CONTENT_TYPE[format], format }
      } catch (err) {
        if (err instanceof ImageProcessingError) throw err
        throw new ImageProcessingError("decode", "wasm codec failed to process the image")
      }
    },
  }
}
