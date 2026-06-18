import { detectFileType, type FileType } from "./detect.ts"

/**
 * Validate an upload's **size** and **real type** (by magic bytes, not the client's `Content-Type`).
 * Pair with `c.boundedBody(maxBytes)` from `@nifrajs/core` to bound the *read* itself: read the body
 * under the cap, then `validateUpload(bytes, …)` to confirm the size + sniff the type.
 */

export type UploadResult =
  | { readonly ok: true; readonly mime: string; readonly ext: string; readonly bytes: Uint8Array }
  | {
      readonly ok: false
      readonly reason: "too_large" | "empty" | "unrecognized" | "type_not_allowed"
      /** The sniffed type, when one was detected (set for `type_not_allowed`). */
      readonly detected?: FileType
    }

export interface ValidateUploadOptions {
  /** Max byte length. A `Blob` over this is rejected without reading it. */
  readonly maxBytes: number
  /** Allowed MIME types — exact (`"image/png"`) or a `image/*` wildcard. Omit ⇒ any recognized type. */
  readonly accept?: readonly string[]
}

const matchesAccept = (mime: string, pattern: string): boolean =>
  pattern === mime || (pattern.endsWith("/*") && mime.startsWith(pattern.slice(0, -1)))

/** Validate uploaded bytes/Blob: size cap + magic-byte type sniff against an optional allow-list. */
export async function validateUpload(
  input: Uint8Array | ArrayBuffer | Blob,
  options: ValidateUploadOptions,
): Promise<UploadResult> {
  // Reject an oversized Blob by its declared size before buffering it into memory.
  if (input instanceof Blob && input.size > options.maxBytes)
    return { ok: false, reason: "too_large" }
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(await input.arrayBuffer())

  if (bytes.byteLength > options.maxBytes) return { ok: false, reason: "too_large" }
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" }

  const detected = detectFileType(bytes)
  if (detected === null) return { ok: false, reason: "unrecognized" }
  if (
    options.accept !== undefined &&
    !options.accept.some((p) => matchesAccept(detected.mime, p))
  ) {
    return { ok: false, reason: "type_not_allowed", detected }
  }
  return { ok: true, mime: detected.mime, ext: detected.ext, bytes }
}
