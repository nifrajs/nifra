import { definePlugin } from "@nifrajs/core/server"

/** 32-bit FNV-1a over bytes → hex. A fast, dependency-free content fingerprint for ETags - not crypto. */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

export interface ETagOptions {
  /** Emit a weak validator (`W/"…"`). Default `true` - it's a content hash, not a byte-for-byte promise. */
  readonly weak?: boolean
  /** Maximum response bytes to hash. Default `1_000_000`; larger responses pass through unchanged. */
  readonly maxBytes?: number
}

const ETAG_ENCODER = new TextEncoder()

/**
 * A {@link definePlugin} plugin that adds a content-hash `ETag` to `GET` `200` responses and returns
 * **`304 Not Modified`** when the client's `If-None-Match` matches - saving bandwidth on unchanged
 * responses. Built on the portable `onResponseBody` tier: the hook receives the final
 * framework-serialized bytes on every runtime with nothing drained, so the middleware stays on
 * Node's direct writer. Handler-returned raw `Response`s (streams, proxied fetches) pass through
 * untagged, and bodies past `maxBytes` are left unchanged. Idempotent.
 */
export function etag(options: ETagOptions = {}) {
  const prefix = (options.weak ?? true) ? "W/" : ""
  const maxBytes = options.maxBytes ?? 1_000_000
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new Error("etag: maxBytes must be a non-negative integer")
  }
  return definePlugin("etag", (app) =>
    app.use({
      onResponseBody(body, headers, req, status) {
        if (req.method !== "GET" || status !== 200) return undefined
        const bytes = typeof body === "string" ? ETAG_ENCODER.encode(body) : body
        if (bytes.byteLength > maxBytes) return undefined
        const tag = `${prefix}"${fnv1a(bytes)}"`
        headers.set("etag", tag)
        if (matchesIfNoneMatch(req.header("if-none-match"), tag)) {
          // A 304 carries no body - drop the body-describing headers so strict intermediaries
          // don't see a null body with a non-zero Content-Length.
          headers.delete("content-length")
          headers.delete("content-type")
          return { body: null, status: 304 }
        }
        return undefined
      },
    }),
  )
}

function matchesIfNoneMatch(value: string | null, tag: string): boolean {
  if (value === null) return false
  const normalizedTag = weakComparableTag(tag)
  for (const part of value.split(",")) {
    const candidate = part.trim()
    if (candidate === "*") return true
    if (weakComparableTag(candidate) === normalizedTag) return true
  }
  return false
}

function weakComparableTag(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag
}
