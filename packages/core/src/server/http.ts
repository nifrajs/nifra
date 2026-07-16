/**
 * Dependency-free HTTP helpers shared by the kernel and the opt-in request lanes (idempotency,
 * effect-ledger). Kept in a leaf module so a lane can reuse them without importing the server, and so
 * the server can reuse them without pulling a lane's feature code into the base bundle.
 */

/** A uniform JSON error envelope: `{ ok: false, error }` at the given status. */
export function jsonError(
  status: number,
  error: string,
  headers?: Record<string, string>,
): Response {
  return Response.json(
    { ok: false, error },
    headers !== undefined ? { status, headers } : { status },
  )
}

export interface UrlParts {
  readonly pathname: string
  readonly search: string
}

// Extract pathname + query WITHOUT a full WHATWG `new URL(req.url)` parse.
// `req.url` from every supported runtime is an absolute, already-normalized URL, so the pathname is
// the substring after `scheme://host[:port]` up to `?`/`#`. Query-schema routes also need the search
// string; parsing both in one scanner avoids the old `pathnameOf()` + `searchOf()` double scan.
export function urlPartsOf(url: string): UrlParts {
  const schemeEnd = url.indexOf("://")
  const start = schemeEnd === -1 ? url.indexOf("/") : url.indexOf("/", schemeEnd + 3)
  if (start === -1) return { pathname: "/", search: "" }

  let pathEnd = url.length
  let searchStart = -1
  let searchEnd = url.length
  for (let i = start; i < url.length; i++) {
    const c = url.charCodeAt(i)
    if (c === 63 /* ? */ && searchStart === -1) {
      pathEnd = i
      searchStart = i
    } else if (c === 35 /* # */) {
      if (searchStart === -1) pathEnd = i
      searchEnd = i
      break
    }
  }

  return {
    pathname: url.slice(start, pathEnd),
    search: searchStart === -1 ? "" : url.slice(searchStart, searchEnd),
  }
}

// Extract the pathname WITHOUT a full WHATWG `new URL(req.url)` parse. Kept as a public-ish helper
// for tests and callers that only need the path; the request hot path uses `urlPartsOf()` once.
export function pathnameOf(url: string): string {
  return urlPartsOf(url).pathname
}
