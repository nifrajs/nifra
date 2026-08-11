import { defineRouterPlugin, type ResponseBodyReplacement } from "@nifrajs/core/server"

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

async function sha256Tag(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input))
  let hex = ""
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0")
  return hex
}

const concat = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

type ReadBytes = { readonly bytes: Uint8Array } | { readonly response: Response }

interface ChunkReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
}

/** Read a raw response without losing a streamed body when the cap is exceeded or the upstream
 * fails. The already-read prefix is replayed through the same reader instead of cancelling a clone,
 * which can stall the original body on some runtimes. */
async function readBytesCapped(res: Response, maxBytes: number): Promise<ReadBytes> {
  const body = res.body
  if (body === null) return { bytes: new Uint8Array() }
  const reader = body.getReader() as unknown as ChunkReader
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return { bytes: concat(chunks, total) }
      if (value === undefined) return { response: replayFrom(res, chunks, reader) }
      chunks.push(value)
      total += value.byteLength
      if (total > maxBytes) return { response: replayFrom(res, chunks, reader) }
    }
  } catch {
    return { response: replayFrom(res, chunks, reader) }
  }
}

function replayFrom(res: Response, chunks: readonly Uint8Array[], reader: ChunkReader): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done || value === undefined) controller.close()
        else controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

/**
 * A {@link defineRouterPlugin} plugin that adds a content-hash `ETag` to `GET` `200` responses and returns
 * **`304 Not Modified`** when the client's `If-None-Match` matches - saving bandwidth on unchanged
 * responses. Built on the portable `onResponseBody` tier: the hook receives the final
 * framework-serialized bytes on every runtime with nothing drained, so the middleware stays on
 * Node's direct writer. Handler-returned raw `Response`s (streams, proxied fetches) use a capped,
 * replaying fallback so oversized bodies remain intact. Idempotent.
 */
export function etag(options: ETagOptions = {}) {
  const weak = options.weak ?? true
  const prefix = weak ? "W/" : ""
  const maxBytes = options.maxBytes ?? 1_000_000
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("etag: maxBytes must be a non-negative safe integer")
  }
  return defineRouterPlugin("etag", (app) =>
    app.use({
      onResponseBody(body, headers, req, status) {
        if (req.method !== "GET" || status !== 200) return undefined
        const bytes = typeof body === "string" ? ETAG_ENCODER.encode(body) : body
        if (bytes.byteLength > maxBytes) return undefined
        const finish = (fingerprint: string): ResponseBodyReplacement | undefined => {
          const tag = prefix + String.fromCharCode(34) + fingerprint + String.fromCharCode(34)
          headers.set("etag", tag)
          if (matchesIfNoneMatch(req.header("if-none-match"), tag)) {
            // A 304 carries no body - drop the body-describing headers so strict intermediaries
            // do not see a null body with a non-zero Content-Length.
            headers.delete("content-length")
            headers.delete("content-type")
            return { body: null, status: 304 }
          }
          return undefined
        }
        if (weak) return finish(fnv1a(bytes))
        return sha256Tag(bytes).then(finish)
      },
      onResponseRaw(response, req) {
        if (req.method !== "GET" || response.status !== 200 || response.body === null) {
          return response
        }
        const declared = response.headers.get("content-length")
        if (declared !== null && /^(?:0|[1-9]\d*)$/.test(declared) && Number(declared) > maxBytes) {
          return response
        }
        return etagRawResponse(response, req, weak, prefix, maxBytes)
      },
    }),
  )
}

async function etagRawResponse(
  response: Response,
  req: Request,
  weak: boolean,
  prefix: string,
  maxBytes: number,
): Promise<Response> {
  const read = await readBytesCapped(response, maxBytes)
  if ("response" in read) return read.response
  const fingerprint = weak ? fnv1a(read.bytes) : await sha256Tag(read.bytes)
  const tag = prefix + String.fromCharCode(34) + fingerprint + String.fromCharCode(34)
  const headers = new Headers(response.headers)
  headers.set("etag", tag)
  if (matchesIfNoneMatch(req.headers.get("if-none-match"), tag)) {
    headers.delete("content-length")
    headers.delete("content-type")
    return new Response(null, { status: 304, headers })
  }
  // The body was consumed and rebuilt from bytes. Re-derive framing at the serving adapter
  // instead of trusting a stale upstream declaration.
  headers.delete("content-length")
  return new Response(read.bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
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
