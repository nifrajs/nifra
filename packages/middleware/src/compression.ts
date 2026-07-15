import { definePlugin } from "@nifrajs/core/server"

export interface CompressionOptions {
  /** Don't compress bodies smaller than this many bytes. Default `1024`. Enforced by peeking the body
   * (see below) since runtimes rarely expose `Content-Length` on a constructed `Response`. */
  readonly threshold?: number
  /** Decide whether a `Content-Type` is worth compressing. Default: text, JSON/+json, JS, XML/+xml,
   * NDJSON, wasm, SVG. Already-compressed media (images, video, archives) is skipped. */
  readonly compressible?: (contentType: string) => boolean
}

// Text-like payloads benefit from gzip; binary media (images/video/archives) is already compressed.
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|[\w.-]+\+json|javascript|xml|[\w.-]+\+xml|wasm|x-ndjson)|image\/svg\+xml)/i

const defaultCompressible = (contentType: string): boolean => COMPRESSIBLE.test(contentType)

const concat = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

const gzipHeaders = (source: Headers): Headers => {
  const headers = new Headers(source)
  headers.set("content-encoding", "gzip")
  headers.delete("content-length") // compressed length is unknown up front → chunked
  const vary = headers.get("vary")
  if (vary === null) headers.set("vary", "Accept-Encoding")
  else if (!vary.toLowerCase().split(",").includes("accept-encoding"))
    headers.set("vary", `${vary}, Accept-Encoding`)
  return headers
}

/**
 * Transparently **gzip** responses when the client sends `Accept-Encoding: gzip` and the body is a
 * compressible type larger than `threshold`. Uses the Web-standard `CompressionStream` (streaming, no
 * full-body buffering), so it runs on every nifra runtime including the edge. gzip is the one encoding
 * `CompressionStream` guarantees everywhere; brotli isn't part of the standard, so it's not offered.
 *
 * The body is **peeked** up to `threshold` bytes to enforce the size floor: a response that ends below
 * the threshold is sent uncompressed (gzip's ~20-byte overhead would enlarge it), and only larger
 * bodies are compressed — the buffered prefix is replayed and the remainder streamed. (Runtimes rarely
 * set `Content-Length` on a constructed `Response`, so the header alone can't gate this.)
 *
 * Skips: clients that don't accept gzip, already-encoded responses, bodyless responses (204/304/HEAD),
 * `Range` responses (206 / `Content-Range`), `Cache-Control: no-transform`, and non-compressible types.
 * Adds `Vary: Accept-Encoding`.
 *
 * ```ts
 * app.use(compression())
 * ```
 */
export function compression(options: CompressionOptions = {}) {
  const threshold = options.threshold ?? 1024
  const isCompressible = options.compressible ?? defaultCompressible
  return definePlugin("compression", (app) =>
    app.onResponse(async (res, req) => {
      const body = res.body
      if (body === null) return res // 204/304/HEAD — nothing to compress
      if (!(req.headers.get("accept-encoding") ?? "").toLowerCase().includes("gzip")) return res
      if (res.headers.has("content-encoding")) return res // already encoded
      if (res.status === 206 || res.headers.has("content-range")) return res // ranges pass through
      if ((res.headers.get("cache-control") ?? "").includes("no-transform")) return res
      if (!isCompressible(res.headers.get("content-type") ?? "")) return res
      const declared = res.headers.get("content-length")
      if (declared !== null && Number(declared) < threshold) return res // fast path when length is known

      // Peek up to `threshold` bytes to decide whether compressing is worth it.
      const reader = body.getReader()
      const buffered: Uint8Array[] = []
      let total = 0
      while (total < threshold) {
        const { done, value } = await reader.read()
        if (done) {
          // Body ended below the threshold — too small to be worth gzipping. Emit as-is.
          return new Response(concat(buffered, total), {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          })
        }
        buffered.push(value)
        total += value.byteLength
      }
      // Over the threshold: replay the buffered prefix, then stream the rest — all through gzip.
      // (No explicit generic: it lets the chunk type infer from the non-shared reader so the stream
      // matches `CompressionStream`'s `Uint8Array` typing.)
      const source = new ReadableStream({
        start(controller) {
          for (const chunk of buffered) controller.enqueue(chunk)
        },
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) controller.close()
          else controller.enqueue(value)
        },
        cancel: (reason) => reader.cancel(reason),
      })
      return new Response(source.pipeThrough(new CompressionStream("gzip")), {
        status: res.status,
        statusText: res.statusText,
        headers: gzipHeaders(res.headers),
      })
    }),
  )
}
