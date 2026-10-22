/**
 * `@nifrajs/uploads` - file-upload hardening, edge-safe.
 *
 * - {@link validateUpload} - size cap + magic-byte type allow-list (the real type from the bytes, not
 *   the client's `Content-Type`). Pair with `@nifrajs/core`'s `c.boundedBody(maxBytes)` to also bound
 *   the read. The detection alone is `detectFileType` from `@nifrajs/core/file-type`.
 * - {@link signDownloadUrl} / {@link verifyDownloadUrl} - short-TTL, tamper-evident download URLs.
 * - {@link stripImageMetadata} - drop EXIF/GPS by re-encoding via any `@nifrajs/image` backend.
 */
export {
  type SignDownloadUrlOptions,
  signDownloadUrl,
  verifyDownloadUrl,
} from "./sign.ts"
export {
  ImagePixelLimitError,
  type ImageReencoder,
  type StripImageMetadataOptions,
  stripImageMetadata,
} from "./strip.ts"
export {
  type UploadResult,
  type ValidateUploadOptions,
  validateUpload,
} from "./validate.ts"
