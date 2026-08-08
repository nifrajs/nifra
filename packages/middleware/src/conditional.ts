import { withHeaders } from "./_utils.ts"

export interface ConditionalResponseOptions {
  /** Entity tag to attach and compare using HTTP weak comparison for GET/HEAD. */
  readonly etag?: string
  /** Last-modified validator to attach and compare at one-second HTTP date precision. */
  readonly lastModified?: Date
}

function lastModifiedHeader(date: Date | undefined): string | undefined {
  if (date === undefined) return undefined
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("conditionalResponse: lastModified must be a valid Date")
  }
  return date.toUTCString()
}

function weakTag(value: string): string {
  return value.startsWith("W/") ? value.slice(2) : value
}

function matchesIfNoneMatch(value: string, etag: string): boolean {
  const comparable = weakTag(etag)
  return value.split(",").some((candidate) => {
    const item = candidate.trim()
    return item === "*" || weakTag(item) === comparable
  })
}

function isFresh(request: Request, options: ConditionalResponseOptions): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  const ifNoneMatch = request.headers.get("if-none-match")
  if (ifNoneMatch !== null && options.etag !== undefined) {
    return matchesIfNoneMatch(ifNoneMatch, options.etag)
  }
  if (ifNoneMatch !== null) return false
  const modified = options.lastModified?.getTime()
  const since = request.headers.get("if-modified-since")
  return (
    modified !== undefined &&
    since !== null &&
    Number.isFinite(modified) &&
    Number.isFinite(Date.parse(since)) &&
    Math.floor(Date.parse(since) / 1000) >= Math.floor(modified / 1000)
  )
}

/** Apply validators to a response and produce a standards-compliant 304 when it is fresh. */
export function conditionalResponse(
  request: Request,
  response: Response,
  options: ConditionalResponseOptions = {},
): Response {
  const modified = lastModifiedHeader(options.lastModified)
  if (response.status < 200 || response.status >= 300) return response
  if (!isFresh(request, options)) {
    if (options.etag === undefined && modified === undefined) return response
    return withHeaders(response, (headers) => {
      if (options.etag !== undefined) headers.set("etag", options.etag)
      if (modified !== undefined) headers.set("last-modified", modified)
    })
  }
  const headers = new Headers(response.headers)
  if (options.etag !== undefined) headers.set("etag", options.etag)
  if (modified !== undefined) headers.set("last-modified", modified)
  headers.delete("content-length")
  headers.delete("content-type")
  void response.body?.cancel().catch(() => {})
  return new Response(null, { status: 304, headers })
}
