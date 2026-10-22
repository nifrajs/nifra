import { repeatedPrefixOf, withResponseObserver } from "@nifrajs/core/response-observer"
import { defineRouterPlugin, type Middleware, type ResponseHeadersView } from "@nifrajs/core/server"

export interface CompressionOptions {
  /** Don't compress bodies smaller than this many bytes. Default `1024`. Enforced by peeking the body
   * (see below) since runtimes rarely expose `Content-Length` on a constructed `Response`. */
  readonly threshold?: number
  /** Decide whether a `Content-Type` is worth compressing. Default: text, JSON/+json, JS, XML/+xml,
   * NDJSON, wasm, SVG. Already-compressed media (images, video, archives) is skipped. */
  readonly compressible?: (contentType: string) => boolean
}

// Text-like payloads benefit from gzip; binary media (images/video/archives) is already compressed.
// Not an event stream: gzip holds each event until its window fills, so none would arrive on time.
const COMPRESSIBLE =
  /^(?:text\/(?!event-stream\b)|application\/(?:json|[\w.-]+\+json|javascript|xml|[\w.-]+\+xml|wasm|x-ndjson)|image\/svg\+xml)/i

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
  weakenEtag(headers)
  return headers
}

/** A strong ETag names the identity bytes; the gzip bytes are another representation, so the tag is
 * weakened (as nginx does) rather than shared by both - a cache or range request trusting it to
 * mean byte-identical would otherwise splice one representation into the other. */
function weakenEtag(headers: ResponseHeadersView): void {
  const etag = headers.get("etag")
  if (etag !== null && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`)
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
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>
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
  if (response.headers.has("content-encoding")) return response
  if (response.status === 206 || response.headers.has("content-range")) return response
  if (hasNoTransform(response.headers.get("cache-control"))) return response
  if (!isCompressible(response.headers.get("content-type") ?? "")) return response
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) < threshold) return response
  // From here the representation depends on Accept-Encoding. A length-less body is not peeked for a
  // client that takes no gzip, so it is marked as varying whatever its size.
  if (!acceptsGzip(req.headers.get("accept-encoding"))) return varyingOnEncoding(response)

  return compressRawBody(response, body, threshold)
}

/** The identity representation of a response that a gzip-accepting client would get compressed. */
function varyingOnEncoding(response: Response): Response {
  const headers = new Headers(response.headers)
  addGzipVary(headers)
  if (headers.get("vary") === response.headers.get("vary")) return response
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Whether `body` encodes to at least `threshold` bytes. UTF-8 spends 1 to 3 bytes per UTF-16 unit,
 * so the length alone settles most strings without encoding them. */
function reachesThreshold(body: string | Uint8Array, threshold: number): boolean {
  if (typeof body !== "string") return body.byteLength >= threshold
  if (body.length >= threshold) return true
  return body.length * 3 >= threshold && GZIP_ENCODER.encode(body).byteLength >= threshold
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
        return new Response(concat(buffered, total).slice(), {
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

  const replaying: RawReader = {
    read: () => {
      const value = buffered.shift()
      return value === undefined ? reader.read() : Promise.resolve({ done: false, value })
    },
    cancel: (reason) => reader.cancel(reason),
  }
  planLookup ??= gzipPlanFor(globalThis)
  return new Response(streamedGzip(replaying, zlibModule(), planLookup, bytesCompare()), {
    status: response.status,
    statusText: response.statusText,
    headers: gzipHeaders(response.headers),
  })
}

interface GzipStream {
  write(chunk: Uint8Array): boolean
  flush(kind: number, callback: () => void): void
  end(): void
  destroy(): void
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown
  once(event: "end" | "error", listener: (error?: unknown) => void): unknown
}

interface DeflateOptions {
  readonly finishFlush: number
  readonly dictionary?: Uint8Array
}

/** The `node:zlib` calls the segmented lane needs. */
interface SegmentCalls {
  deflateRawSync(body: Uint8Array, options: DeflateOptions): Uint8Array
  crc32(data: Uint8Array, value?: number): number
}

interface Zlib {
  createGzip(): GzipStream
  gzipSync?(body: string | Uint8Array): Uint8Array
  gzip?(body: string | Uint8Array, done: (error: Error | null, result: Uint8Array) => void): void
  deflateRawSync?(body: Uint8Array, options: DeflateOptions): Uint8Array
  deflateRaw?(
    body: Uint8Array,
    options: DeflateOptions,
    done: (error: Error | null, result: Uint8Array) => void,
  ): void
  crc32?(data: Uint8Array, value?: number): number
  readonly constants: { readonly Z_SYNC_FLUSH: number }
}

const isZlib = (value: unknown): value is Zlib =>
  typeof value === "object" &&
  value !== null &&
  "createGzip" in value &&
  typeof value.createGzip === "function" &&
  "constants" in value &&
  typeof value.constants === "object" &&
  value.constants !== null &&
  "Z_SYNC_FLUSH" in value.constants

let zlibLookup: { readonly zlib: Zlib | undefined } | undefined

function builtinModule(specifier: string): unknown {
  try {
    const proc: unknown = Reflect.get(globalThis, "process")
    const load: unknown =
      typeof proc === "object" && proc !== null ? Reflect.get(proc, "getBuiltinModule") : undefined
    return typeof load === "function" ? load.call(proc, specifier) : undefined
  } catch {
    return undefined
  }
}

function zlibModule(): Zlib | undefined {
  if (zlibLookup !== undefined) return zlibLookup.zlib
  const module = builtinModule("node:zlib")
  const zlib = isZlib(module) ? module : undefined
  zlibLookup = { zlib }
  return zlib
}

type CompareBytes = (a: Uint8Array, b: Uint8Array) => number

let compareLookup: { readonly compare: CompareBytes | undefined } | undefined

/** `node:buffer`'s native compare: a JS loop took 7 us over a 16 KB prefix, this 0.35 us. */
function bytesCompare(): CompareBytes | undefined {
  if (compareLookup !== undefined) return compareLookup.compare
  const module = builtinModule("node:buffer")
  const buffer: unknown =
    typeof module === "object" && module !== null ? Reflect.get(module, "Buffer") : undefined
  const compare: unknown = typeof buffer === "function" ? Reflect.get(buffer, "compare") : undefined
  compareLookup = {
    compare:
      typeof compare === "function" ? (a, b) => Reflect.apply(compare, buffer, [a, b]) : undefined,
  }
  return compareLookup.compare
}

/** Up to which length (UTF-16 units for a string) a buffered body is gzipped inline, then by one call;
 * and whether a streamed body is gzipped by deflate segments rather than one sync-flushed stream. */
export interface GzipPlan {
  readonly inlineMax: number
  readonly oneShotMax: number
  readonly segments: boolean
}

/**
 * Where each way of gzipping a buffered JSON body measured fastest over HTTP (16 connections). Inline
 * `gzipSync` skips the hand-off that dominates a small body: on Bun up to 4 KiB (2 KB: 1.32x node:zlib's
 * one-shot `gzip`), past which the one-shot runs on the thread pool in parallel with the loop (32 KB:
 * 2.11x inline). Deno always gzips inline (256 KB: 1.54x `CompressionStream`): its one-shot swells the
 * process by ~250 MB, after which inline calls serve at 0.6x. Node never gzips inline (16 KB: 0.44x),
 * and its one-shot beats `CompressionStream` only up to 8 KiB (2 KB: 1.16x, 16 KB: 0.92x). These bodies
 * compress 4-6x like real pages; a far cheaper one (100x+) loses the hand-off on Bun (33 KB: 0.93x).
 *
 * A streamed page (a 16 KB shell, then three frames of 150-350 bytes; 64 connections) measured on Bun
 * 178 us of CPU per response by segments against 250 us through `createGzip`, at 0.93x the requests
 * per second, and 97 us at 1.08x with the shell's segment reused. Node's and Deno's native streams
 * win there: segments cost them 1.12x and 1.10x the CPU at 0.90x and 0.92x the requests.
 */
export function gzipPlanFor(runtime: {
  readonly Bun?: unknown
  readonly Deno?: unknown
}): GzipPlan {
  if (runtime.Bun !== undefined)
    return { inlineMax: 4 * 1024, oneShotMax: Number.POSITIVE_INFINITY, segments: true }
  if (runtime.Deno !== undefined) {
    return {
      inlineMax: Number.POSITIVE_INFINITY,
      oneShotMax: Number.POSITIVE_INFINITY,
      segments: false,
    }
  }
  return { inlineMax: -1, oneShotMax: 8 * 1024, segments: false }
}

/** Gzip a buffered body by `plan`, through `zlib` where it has the call, else `CompressionStream`. */
export function gzipBuffered(
  body: string | Uint8Array,
  plan: GzipPlan,
  zlib: Pick<Zlib, "gzipSync" | "gzip"> | undefined,
): Uint8Array | Promise<Uint8Array> {
  const length = typeof body === "string" ? body.length : body.byteLength
  const gzipSync = zlib?.gzipSync
  if (gzipSync !== undefined && length <= plan.inlineMax) return gzipSync.call(zlib, body)
  const gzip = zlib?.gzip
  if (gzip !== undefined && length <= plan.oneShotMax) {
    return new Promise((resolve, reject) => {
      gzip.call(zlib, body, (error, result) => (error === null ? resolve(result) : reject(error)))
    })
  }
  return gzipBytes(typeof body === "string" ? GZIP_ENCODER.encode(body) : body)
}

let planLookup: GzipPlan | undefined

/** Gzip the body `reader` reads so each chunk's bytes reach the client as soon as it arrives: by
 * deflate segments read straight from `reader` where `plan` says so and `zlib` has the calls, else
 * through one sync-flushed stream, else `CompressionStream`. */
export function streamedGzip(
  reader: RawReader,
  zlib: Zlib | undefined,
  plan: GzipPlan,
  compare: CompareBytes | undefined,
): ReadableStream<Uint8Array> {
  if (zlib !== undefined && plan.segments && hasSegmentCalls(zlib)) {
    return segmentedGzip(reader, zlib, plan, compare)
  }
  const source = new ReadableStream({
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
  return zlib === undefined
    ? source.pipeThrough(new CompressionStream("gzip"))
    : syncFlushedGzip(zlib, source)
}

const hasSegmentCalls = (zlib: Zlib): zlib is Zlib & SegmentCalls =>
  typeof zlib.deflateRawSync === "function" && typeof zlib.crc32 === "function"

/** A gzip member's header: no name, time or flags. */
const GZIP_HEADER = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff)

/** How far back into the body a segment may refer. A page's 150-byte hole frame came to 142 bytes
 * alone, 90 with 2 KB before it (7.5 us) and 88 with 8 KB (11.4 us). */
const DICTIONARY_BYTES = 2 * 1024

/** The compressed form of a repeated prefix's bytes, per source. */
interface PrefixSegment {
  readonly length: number
  readonly segment: Uint8Array | Promise<Uint8Array>
}
/** A source seen once has no segment yet. */
const prefixSegments = new WeakMap<
  Uint8Array,
  PrefixSegment | { readonly length: number; readonly segment: undefined }
>()

const NO_BYTES = new Uint8Array(0)

/** The last `DICTIONARY_BYTES` of `window` followed by `chunk`, copied: the chunk is not ours to keep. */
function slide(window: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (chunk.byteLength >= DICTIONARY_BYTES) return chunk.slice(chunk.byteLength - DICTIONARY_BYTES)
  const kept = window.subarray(Math.max(0, window.byteLength + chunk.byteLength - DICTIONARY_BYTES))
  const next = new Uint8Array(kept.byteLength + chunk.byteLength)
  next.set(kept)
  next.set(chunk, kept.byteLength)
  return next
}

/**
 * Gzip each upstream chunk as its own raw deflate segment ending in a sync flush, so the chunk's bytes
 * go out at once. The segments join into one deflate stream, which an empty final block and the gzip
 * trailer close. Each segment may refer back into the body's previous `DICTIONARY_BYTES`, so a small
 * chunk after a large one compresses as it would in one stream. A chunk a producer marked with a
 * repeated prefix (a cached page shell) reuses that prefix's segment once compressed, when `compare`
 * shows the chunk still holds the prefix's bytes. Measured against `createGzip` in `gzipPlanFor`.
 */
function segmentedGzip(
  reader: RawReader,
  zlib: Zlib & SegmentCalls,
  plan: GzipPlan,
  compare: CompareBytes | undefined,
): ReadableStream<Uint8Array> {
  const flush = zlib.constants.Z_SYNC_FLUSH
  let window: Uint8Array = NO_BYTES
  let crc = 0
  let size = 0
  let started = false
  const deflate = (bytes: Uint8Array, dictionary: Uint8Array): Uint8Array | Promise<Uint8Array> => {
    const options: DeflateOptions =
      dictionary.byteLength === 0 ? { finishFlush: flush } : { finishFlush: flush, dictionary }
    const deflateRaw = zlib.deflateRaw
    if (bytes.byteLength <= plan.inlineMax || deflateRaw === undefined) {
      return zlib.deflateRawSync(bytes, options)
    }
    return new Promise((resolve, reject) => {
      deflateRaw.call(zlib, bytes, options, (error, result) =>
        error === null ? resolve(result) : reject(error),
      )
    })
  }
  /** The marked prefix's segment when `chunk` still holds the prefix's bytes, compressed on its second use. */
  const prefixSegment = (chunk: Uint8Array): PrefixSegment | undefined => {
    const prefix = repeatedPrefixOf(chunk)
    if (
      prefix === undefined ||
      compare === undefined ||
      compare(chunk.subarray(0, prefix.length), prefix.source.subarray(0, prefix.length)) !== 0
    ) {
      return undefined
    }
    const known = prefixSegments.get(prefix.source)
    if (known?.length !== prefix.length) {
      // From the second sight: a shell built for one response would pay a second deflate for nothing.
      prefixSegments.set(prefix.source, { length: prefix.length, segment: undefined })
      return undefined
    }
    if (known.segment !== undefined) return known
    // By the same rule as any chunk: inline, a large prefix holds up every response on the loop.
    // A response that meets the source meanwhile waits on the same segment.
    const segment = deflate(prefix.source.subarray(0, prefix.length), NO_BYTES)
    const entry = { length: prefix.length, segment }
    prefixSegments.set(prefix.source, entry)
    if (segment instanceof Promise) {
      segment.catch(() => {
        if (prefixSegments.get(prefix.source) === entry) prefixSegments.delete(prefix.source)
      })
    }
    return entry
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // A pull that enqueues nothing is not called again, so an empty chunk is read past here.
      let read = await reader.read()
      while (!read.done && read.value?.byteLength === 0) read = await reader.read()
      const { done, value } = read
      const parts: Uint8Array[] = started ? [] : [GZIP_HEADER]
      started = true
      if (done || value === undefined) {
        const trailer = new Uint8Array(10)
        trailer[0] = 3 // An empty final block with fixed codes: BFINAL, BTYPE 01, end of block.
        const view = new DataView(trailer.buffer)
        view.setUint32(2, crc >>> 0, true)
        view.setUint32(6, size >>> 0, true)
        parts.push(trailer)
        controller.enqueue(concat(parts, total(parts)))
        controller.close()
        return
      }
      crc = zlib.crc32(value, crc)
      size += value.byteLength
      let rest = value
      const prefix = prefixSegment(value)
      if (prefix !== undefined) {
        parts.push(await prefix.segment)
        window = slide(window, value.subarray(0, prefix.length))
        rest = value.subarray(prefix.length)
      }
      if (rest.byteLength > 0) {
        parts.push(await deflate(rest, window))
        window = slide(window, rest)
      }
      controller.enqueue(concat(parts, total(parts)))
    },
    cancel: (reason) => reader.cancel(reason),
  })
}

const total = (parts: readonly Uint8Array[]): number =>
  parts.reduce((sum, part) => sum + part.byteLength, 0)

/** `CompressionStream` holds deflate output until its window fills or the input closes, so a
 * streamed shell would not reach the client until the whole page did. A sync flush after each
 * upstream chunk emits what that chunk compressed to, at the cost of a few bytes per flush. */
function syncFlushedGzip(
  zlib: Zlib,
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const gzip = zlib.createGzip()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      gzip.on("data", (chunk) => controller.enqueue(chunk))
      gzip.once("error", (error) => controller.error(error))
    },
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        await new Promise((resolve) => {
          gzip.once("end", resolve)
          gzip.end()
        })
        controller.close()
        return
      }
      gzip.write(value)
      await new Promise<void>((resolve) => gzip.flush(zlib.constants.Z_SYNC_FLUSH, resolve))
    },
    cancel(reason) {
      gzip.destroy()
      return reader.cancel(reason)
    },
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
 * On Cloudflare Workers it does nothing: the runtime gzips any body sent with `Content-Encoding:
 * gzip` again, and the platform compresses responses for clients that accept it.
 *
 * Skips: clients that don't accept gzip, already-encoded responses, bodyless responses,
 * `Range` responses (206 / `Content-Range`), `Cache-Control: no-transform`, non-compressible
 * types, and bodies below `threshold` (gzip's ~20-byte overhead would enlarge them). Adds
 * `Vary: Accept-Encoding` to every response it would compress for a gzip-accepting client, the
 * identity one sent to any other client included.
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
  if (globalThis.navigator?.userAgent === "Cloudflare-Workers") {
    return defineRouterPlugin("compression", (app) => app)
  }
  return defineRouterPlugin("compression", (app) =>
    app.use(
      withResponseObserver<Middleware>({
        onResponseBody(body, headers, req, status) {
          if (headers.has("content-encoding")) return undefined
          if (status === 206 || headers.has("content-range")) return undefined
          if (hasNoTransform(headers.get("cache-control"))) return undefined
          if (!isCompressible(headers.get("content-type") ?? "")) return undefined
          if (!reachesThreshold(body, threshold)) return undefined
          // Both representations name the header they vary on, so a shared cache keeps them apart.
          addGzipVary(headers)
          if (!acceptsGzip(req.header("accept-encoding"))) return undefined
          const encoded = (compressed: Uint8Array): Uint8Array => {
            headers.set("content-encoding", "gzip")
            headers.delete("content-length")
            weakenEtag(headers)
            return compressed
          }
          planLookup ??= gzipPlanFor(globalThis)
          const compressed = gzipBuffered(body, planLookup, zlibModule())
          return compressed instanceof Promise ? compressed.then(encoded) : encoded(compressed)
        },
        onResponseRaw: (response, req) =>
          compressRawResponse(response, req, threshold, isCompressible),
      }),
    ),
  )
}
