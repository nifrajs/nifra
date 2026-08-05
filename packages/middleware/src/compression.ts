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

const GZIP_ENCODER = new TextEncoder()

/** Gzip a resident buffer through the Web-standard `CompressionStream` (available everywhere). */
async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  // No explicit generic: the chunk type infers from `enqueue`, which keeps the stream assignable
  // to `CompressionStream`'s typing across the Bun/DOM lib variants.
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const compressed = await new Response(
    source.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer()
  return new Uint8Array(compressed)
}

/**
 * Transparently **gzip** responses when the client sends `Accept-Encoding: gzip` and the body is a
 * compressible type larger than `threshold`. Uses the Web-standard `CompressionStream`, so it runs
 * on every nifra runtime including the edge; gzip is the one encoding `CompressionStream`
 * guarantees everywhere, so brotli isn't offered.
 *
 * Built on the portable `onResponseBody` tier: the hook receives the final framework-serialized
 * bytes on every runtime - nothing is drained, the middleware stays on Node's direct writer, and
 * the compressed length is known up front (`Content-Length` framing instead of chunked). A
 * handler-returned raw `Response` (a stream, a proxied fetch) passes through UNcompressed by
 * contract - streamed compression belongs to a dedicated `onResponse` middleware if an app needs
 * it.
 *
 * Skips: clients that don't accept gzip, already-encoded responses, bodyless responses,
 * `Range` responses (206 / `Content-Range`), `Cache-Control: no-transform`, non-compressible
 * types, and bodies below `threshold` (gzip's ~20-byte overhead would enlarge them). Adds
 * `Vary: Accept-Encoding`.
 *
 * ```ts
 * app.use(compression())
 * ```
 */
export function compression(options: CompressionOptions = {}) {
  const threshold = options.threshold ?? 1024
  const isCompressible = options.compressible ?? defaultCompressible
  return definePlugin("compression", (app) =>
    app.use({
      async onResponseBody(body, headers, req, status) {
        if (!(req.header("accept-encoding") ?? "").toLowerCase().includes("gzip")) return undefined
        if (headers.has("content-encoding")) return undefined
        if (status === 206 || headers.has("content-range")) return undefined
        if ((headers.get("cache-control") ?? "").includes("no-transform")) return undefined
        if (!isCompressible(headers.get("content-type") ?? "")) return undefined
        const bytes = typeof body === "string" ? GZIP_ENCODER.encode(body) : body
        if (bytes.byteLength < threshold) return undefined
        const compressed = await gzipBytes(bytes)
        headers.set("content-encoding", "gzip")
        headers.delete("content-length")
        const vary = headers.get("vary")
        if (vary === null) headers.set("vary", "Accept-Encoding")
        else if (!vary.toLowerCase().split(",").includes("accept-encoding")) {
          headers.set("vary", `${vary}, Accept-Encoding`)
        }
        return compressed
      },
    }),
  )
}
