/**
 * `@nifrajs/uploads` - file-upload hardening, edge-safe.
 *
 * - {@link validateUpload} - size cap + magic-byte type allow-list (the real type from the bytes, not
 *   the client's `Content-Type`). Direct request reads follow the configured route body limit; use
 *   `c.boundedBody(maxBytes)` for an explicit per-read cap. The detection alone is `detectFileType`
 *   from `@nifrajs/core/file-type`.
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
