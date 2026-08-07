import { type ByteRange, type ByteRangeResult, parseByteRange } from "@nifrajs/core/range"

// The parser lives in core because `@nifrajs/web`'s `public/` handler needs the identical answer for
// files on disk, and web cannot depend on this package. Re-exported here so the middleware surface
// stays one import.
export { type ByteRange, type ByteRangeResult, parseByteRange }

export interface RangeResponseOptions {
  /** Media type for the complete representation and each single-range response. */
  readonly contentType?: string
  /** Entity tag used for conditional requests and `If-Range`. */
  readonly etag?: string
  /** Validator used for conditional requests and date-form `If-Range`. */
  readonly lastModified?: Date
  /** Optional cache policy copied to the response. */
  readonly cacheControl?: string
}

const TEXT = new TextEncoder()

function bytesOf(body: string | ArrayBuffer | ArrayBufferView | Uint8Array): Uint8Array {
  if (typeof body === "string") return TEXT.encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
}

function httpDate(date: Date): string {
  const time = date.getTime()
  if (!Number.isFinite(time))
    throw new RangeError("rangeResponse: lastModified must be a valid Date")
  return new Date(time).toUTCString()
}

function validators(options: RangeResponseOptions): Headers {
  const headers = new Headers()
  if (options.contentType !== undefined) headers.set("content-type", options.contentType)
  if (options.etag !== undefined) headers.set("etag", options.etag)
  if (options.lastModified !== undefined)
    headers.set("last-modified", httpDate(options.lastModified))
  if (options.cacheControl !== undefined) headers.set("cache-control", options.cacheControl)
  return headers
}

function emptyResponse(status: number, headers: Headers): Response {
  headers.delete("content-length")
  headers.delete("content-type")
  return new Response(null, { status, headers })
}

function matchesIfNoneMatch(value: string, etag: string): boolean {
  const normalized = etag.startsWith("W/") ? etag.slice(2) : etag
  return value.split(",").some((candidate) => {
    const item = candidate.trim()
    if (item === "*") return true
    const comparable = item.startsWith("W/") ? item.slice(2) : item
    return comparable === normalized
  })
}

function ifRangeMatches(value: string | null, options: RangeResponseOptions): boolean {
  if (value === null) return true
  const item = value.trim()
  if (options.etag !== undefined) return !item.startsWith("W/") && item === options.etag
  if (options.lastModified === undefined) return false
  const time = Date.parse(item)
  return (
    Number.isFinite(time) &&
    Math.floor(time / 1000) >= Math.floor(options.lastModified.getTime() / 1000)
  )
}

function shouldReturnNotModified(request: Request, options: RangeResponseOptions): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  const ifNoneMatch = request.headers.get("if-none-match")
  // RFC conditional precedence: an If-None-Match header suppresses date evaluation even when this
  // representation has no ETag to compare. A non-matching tag must not be upgraded to a 304 by an
  // older If-Modified-Since value.
  if (ifNoneMatch !== null) {
    return options.etag !== undefined && matchesIfNoneMatch(ifNoneMatch, options.etag)
  }
  // If-Modified-Since remains a valid fallback when the request did not send If-None-Match.
  const lastModified = options.lastModified?.getTime()
  const ifModifiedSince = request.headers.get("if-modified-since")
  return (
    lastModified !== undefined &&
    Number.isFinite(lastModified) &&
    ifModifiedSince !== null &&
    Number.isFinite(Date.parse(ifModifiedSince)) &&
    Math.floor(Date.parse(ifModifiedSince) / 1000) >= Math.floor(lastModified / 1000)
  )
}

function responseBody(bytes: Uint8Array, request: Request): Uint8Array | null {
  return request.method === "HEAD" ? null : bytes
}

function multipartBytes(
  bytes: Uint8Array,
  ranges: readonly ByteRange[],
  size: number,
  contentType: string,
  boundary: string,
): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  const add = (chunk: Uint8Array): void => {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  for (const range of ranges) {
    add(TEXT.encode(`--${boundary}\r\n`))
    add(TEXT.encode(`Content-Range: bytes ${range.start}-${range.end}/${size}\r\n`))
    add(TEXT.encode(`Content-Type: ${contentType}\r\n\r\n`))
    add(bytes.subarray(range.start, range.end + 1))
    add(TEXT.encode("\r\n"))
  }
  add(TEXT.encode(`--${boundary}--\r\n`))
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/**
 * Create a standards-shaped byte representation response with Range, If-Range, and conditional
 * validator handling. The input is already caller-owned memory; this helper does not read or retain
 * external state. Multiple ranges use `multipart/byteranges` and adjacent ranges are coalesced.
 */
export function rangeResponse(
  request: Request,
  body: string | ArrayBuffer | ArrayBufferView | Uint8Array,
  options: RangeResponseOptions = {},
): Response {
  const bytes = bytesOf(body)
  const headers = validators(options)
  headers.set("accept-ranges", "bytes")

  if (shouldReturnNotModified(request, options)) return emptyResponse(304, headers)

  const requestedRange =
    request.method === "GET" || request.method === "HEAD" ? request.headers.get("range") : null
  const range =
    requestedRange !== null && ifRangeMatches(request.headers.get("if-range"), options)
      ? parseByteRange(requestedRange, bytes.byteLength)
      : { kind: "none" as const }

  if (range.kind === "unsatisfiable") {
    headers.set("content-range", `bytes */${bytes.byteLength}`)
    headers.set("content-length", "0")
    return new Response(null, { status: 416, headers })
  }

  if (range.kind === "none") {
    headers.set("content-length", String(bytes.byteLength))
    return new Response(responseBody(bytes, request), { status: 200, headers })
  }

  const contentType = options.contentType ?? "application/octet-stream"
  if (range.ranges.length === 1) {
    const selected = range.ranges[0]!
    const selectedBytes = bytes.subarray(selected.start, selected.end + 1)
    headers.set("content-range", `bytes ${selected.start}-${selected.end}/${bytes.byteLength}`)
    headers.set("content-length", String(selectedBytes.byteLength))
    return new Response(responseBody(selectedBytes, request), { status: 206, headers })
  }

  const boundary = `nifra-${crypto.randomUUID().replaceAll("-", "")}`
  const selectedBytes = multipartBytes(bytes, range.ranges, bytes.byteLength, contentType, boundary)
  headers.set("content-type", `multipart/byteranges; boundary=${boundary}`)
  headers.set("content-length", String(selectedBytes.byteLength))
  return new Response(responseBody(selectedBytes, request), { status: 206, headers })
}
