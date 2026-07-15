import { definePlugin } from "@nifrajs/core/server"

/** 32-bit FNV-1a over bytes → hex. A fast, dependency-free content fingerprint for ETags — not crypto. */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

export interface ETagOptions {
  /** Emit a weak validator (`W/"…"`). Default `true` — it's a content hash, not a byte-for-byte promise. */
  readonly weak?: boolean
  /** Maximum response bytes to hash. Default `1_000_000`; larger responses pass through unchanged. */
  readonly maxBytes?: number
}

/**
 * A {@link definePlugin} plugin that adds a content-hash `ETag` to `GET` `200` responses and returns
 * **`304 Not Modified`** when the client's `If-None-Match` matches — saving bandwidth on unchanged
 * responses. It reads and rebuilds small bodies only; larger responses pass through unchanged.
 * Idempotent.
 */
export function etag(options: ETagOptions = {}) {
  const prefix = (options.weak ?? true) ? "W/" : ""
  const maxBytes = options.maxBytes ?? 1_000_000
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new Error("etag: maxBytes must be a non-negative integer")
  }
  return definePlugin("etag", (app) =>
    app.onResponse(async (res, req) => {
      if (req.method !== "GET" || res.status !== 200 || res.body === null) return res
      const declared = parseLength(res.headers.get("content-length"))
      if (declared !== undefined && declared > maxBytes) return res
      const body = await readBytesCapped(res, maxBytes)
      if (body === null) return res
      const tag = `${prefix}"${fnv1a(body)}"`
      const headers = new Headers(res.headers)
      headers.set("ETag", tag)
      if (matchesIfNoneMatch(req.headers.get("if-none-match"), tag)) {
        // A 304 carries no body — drop the body-describing headers so strict intermediaries don't see a
        // null body with a non-zero Content-Length.
        headers.delete("content-length")
        headers.delete("content-type")
        return new Response(null, { status: 304, headers })
      }
      return new Response(body, { status: res.status, statusText: res.statusText, headers })
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

function parseLength(value: string | null): number | undefined {
  if (value === null) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return undefined
  return Number(value)
}

async function readBytesCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const body = res.clone().body
  if (body === null) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        const out = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          out.set(chunk, offset)
          offset += chunk.byteLength
        }
        return out
      }
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
}
