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
