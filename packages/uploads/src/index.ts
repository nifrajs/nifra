/**
 * `@nifrajs/uploads` — file-upload hardening, dependency-free + edge-safe.
 *
 * - {@link detectFileType} — sniff the real type from magic bytes (not the client's `Content-Type`).
 * - {@link validateUpload} — size cap + magic-byte type allow-list. Pair with `@nifrajs/core`'s
 *   `c.boundedBody(maxBytes)` to also bound the read.
 * - {@link signDownloadUrl} / {@link verifyDownloadUrl} — short-TTL, tamper-evident download URLs.
 * - {@link stripImageMetadata} — drop EXIF/GPS by re-encoding via any `@nifrajs/image` backend.
 */
export { detectFileType, type FileType } from "./detect.ts"
export {
  type SignDownloadUrlOptions,
  signDownloadUrl,
  verifyDownloadUrl,
} from "./sign.ts"
export {
  type ImageReencoder,
  type StripImageMetadataOptions,
  stripImageMetadata,
} from "./strip.ts"
export {
  type UploadResult,
  type ValidateUploadOptions,
  validateUpload,
} from "./validate.ts"
