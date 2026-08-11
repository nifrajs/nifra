import { definePlugin, type ResponseHeadersView } from "@nifrajs/core/server"

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

/** Honor explicit q=0 exclusions; a client that says `gzip;q=0` must not receive gzip. */
function acceptsGzip(value: string | null): boolean {
  if (value === null) return false
  let wildcard: number | undefined
  let gzip: number | undefined
  for (const item of value.split(",")) {
    const parts = item.trim().split(";")
    const coding = parts[0]?.trim().toLowerCase()
    if (coding !== "gzip" && coding !== "*") continue
    let quality = 1
    for (let i = 1; i < parts.length; i++) {
      const [name, raw] = parts[i]!.trim().split("=", 2)
      if (name?.toLowerCase() === "q") {
        const parsed = Number(raw)
        quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0
      }
    }
    if (coding === "gzip") gzip = quality
    else wildcard = quality
  }
  return (gzip ?? wildcard ?? 0) > 0
}

const GZIP_ENCODER = new TextEncoder()

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
  headers.delete("content-length")
  addGzipVary(headers)
  return headers
}

function addGzipVary(headers: ResponseHeadersView): void {
  const vary = headers.get("vary")
  if (vary === null) {
    headers.set("vary", "Accept-Encoding")
  } else if (
    !vary
      .toLowerCase()
      .split(",")
      .some((part) => part.trim() === "accept-encoding")
  ) {
    headers.set("vary", `${vary}, Accept-Encoding`)
  }
}

function hasNoTransform(value: string | null): boolean {
  return (
    value
      ?.split(",")
      .some(
        (directive) => directive.trim().split(";", 1)[0]?.trim().toLowerCase() === "no-transform",
      ) ?? false
  )
}

interface RawReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
}

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

/** Stream-safe fallback for handler-returned/proxied Responses. Peek only enough to enforce the
 * threshold, then replay the prefix through CompressionStream without buffering the remainder. */
function compressRawResponse(
  response: Response,
  req: Request,
  threshold: number,
  isCompressible: (contentType: string) => boolean,
): Response | Promise<Response> {
  const body = response.body
  if (body === null) return response
  if (response.status === 204 || response.status === 205 || response.status === 304) {
    return response
  }
  if (!acceptsGzip(req.headers.get("accept-encoding"))) return response
  if (response.headers.has("content-encoding")) return response
  if (response.status === 206 || response.headers.has("content-range")) return response
  if (hasNoTransform(response.headers.get("cache-control"))) return response
  if (!isCompressible(response.headers.get("content-type") ?? "")) return response
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) < threshold) return response

  return compressRawBody(response, body, threshold)
}

async function compressRawBody(
  response: Response,
  body: ReadableStream<Uint8Array>,
  threshold: number,
): Promise<Response> {
  const reader = body.getReader() as unknown as RawReader
  const buffered: Uint8Array[] = []
  let total = 0
  try {
    while (total < threshold) {
      const { done, value } = await reader.read()
      if (done) {
        return new Response(concat(buffered, total), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      if (value === undefined) return replayRawResponse(response, buffered, reader)
      buffered.push(value)
      total += value.byteLength
    }
  } catch {
    return replayRawResponse(response, buffered, reader)
  }

  const source = new ReadableStream({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk)
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
  return new Response(source.pipeThrough(new CompressionStream("gzip")), {
    status: response.status,
    statusText: response.statusText,
    headers: gzipHeaders(response.headers),
  })
}

function replayRawResponse(
  response: Response,
  chunks: readonly Uint8Array[],
  reader: RawReader,
): Response {
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
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * Transparently **gzip** responses when the client sends `Accept-Encoding: gzip` and the body is a
 * compressible type larger than `threshold`. Uses the Web-standard `CompressionStream`, so it runs
 * on every nifra runtime including the edge; gzip is the one encoding `CompressionStream`
 * guarantees everywhere, so brotli isn't offered.
 *
 * Built on the portable `onResponseBody` tier for framework-serialized bytes, with a stream-safe raw
 * fallback for handler-returned/proxied Responses. The common JSON path stays on Node's direct
 * writer; raw streams are compressed incrementally without being fully buffered.
 *
 * Skips: clients that don't accept gzip, already-encoded responses, bodyless responses,
 * `Range` responses (206 / `Content-Range`), `Cache-Control: no-transform`, non-compressible
 * types, and bodies below `threshold` (gzip's ~20-byte overhead would enlarge them). Adds
 * `Vary: Accept-Encoding`.
 *
 * **Security (BREACH).** Compression makes the response length depend on its content, so a response
 * that mixes a secret with attacker-reflected input leaks the secret through the compressed size
 * (the BREACH class of attacks). This applies to any HTTP compression, not this middleware
 * specifically. Nifra's own CSRF tokens are HMAC-signed per session and safe to compress, but if a
 * response body reflects request input **and** carries a per-request secret, exclude that route via
 * `compressible`/route scoping, or split the secret and the reflection into separate responses.
 *
 * ```ts
 * app.use(compression())
 * ```
 */
export function compression(options: CompressionOptions = {}) {
  const threshold = options.threshold ?? 1024
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    throw new Error("compression: threshold must be a non-negative safe integer")
  }
  const isCompressible = options.compressible ?? defaultCompressible
  return definePlugin("compression", (app) =>
    app.use({
      onResponseBody(body, headers, req, status) {
        if (!acceptsGzip(req.header("accept-encoding"))) return undefined
        if (headers.has("content-encoding")) return undefined
        if (status === 206 || headers.has("content-range")) return undefined
        if (hasNoTransform(headers.get("cache-control"))) return undefined
        if (!isCompressible(headers.get("content-type") ?? "")) return undefined
        const bytes = typeof body === "string" ? GZIP_ENCODER.encode(body) : body
        if (bytes.byteLength < threshold) return undefined
        return gzipBytes(bytes).then((compressed) => {
          headers.set("content-encoding", "gzip")
          headers.delete("content-length")
          addGzipVary(headers)
          return compressed
        })
      },
      onResponseRaw: (response, req) =>
        compressRawResponse(response, req, threshold, isCompressible),
    }),
  )
}
