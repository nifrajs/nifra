import { type UrlParts, urlPartsOf } from "@nifrajs/core/server"

// A page request reaches the same Request object through mounts, fallback checks, search parsing,
// and rendering. Cache the allocation-light URL split once for that request. WeakMap keeps the cache
// bounded to requests that are still alive and makes the helper safe for every runtime adapter.
const REQUEST_URL_PARTS = new WeakMap<Request, UrlParts>()

export function urlPartsFor(request: Request): UrlParts {
  const cached = REQUEST_URL_PARTS.get(request)
  if (cached !== undefined) return cached
  const parts = urlPartsOf(request.url)
  REQUEST_URL_PARTS.set(request, parts)
  return parts
}

// The origin depends only on the text before the path, which repeats across requests, so each
// distinct prefix is parsed once instead of every request's whole URL. Cleared when full: a client
// can vary the Host header without bound.
const ORIGINS = new Map<string, string>()

/** `new URL(request.url).origin`, or `""` for a URL that does not parse. */
export function originFor(request: { readonly url: string }): string {
  const url = request.url
  const schemeEnd = url.indexOf("://")
  const pathStart = schemeEnd === -1 ? -1 : url.indexOf("/", schemeEnd + 3)
  const prefix = pathStart === -1 ? url : url.slice(0, pathStart)
  let origin = ORIGINS.get(prefix)
  if (origin === undefined) {
    try {
      origin = new URL(prefix).origin
    } catch {
      origin = ""
    }
    if (ORIGINS.size >= 64) ORIGINS.clear()
    ORIGINS.set(prefix, origin)
  }
  return origin
}
