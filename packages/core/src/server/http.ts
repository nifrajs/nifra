/**
 * HTTP helpers shared by the kernel and the opt-in request lanes (idempotency, effect-ledger). Kept
 * in a leaf module (runtime-core aside, itself a leaf) so a lane can reuse them without importing the
 * server, and so the server can reuse them without pulling a lane's feature code into the base bundle.
 */
import { type ResponseResult, status as statusResult } from "./runtime-core.ts"

/**
 * Is `value` a destination that stays on this origin?
 *
 * True only for an absolute path: one leading `/`, never `//` (protocol-relative → another origin),
 * and free of any character a URL parser turns into an origin escape. A leading `/` alone is not
 * enough: under a special scheme `\` parses as `/`, and tab/CR/LF are STRIPPED before parsing, so
 * `/\evil.example` and `/<TAB>/evil.example` both resolve to the external host `evil.example` while
 * passing a `//` test. Rejecting CR/LF here also keeps a validated destination out of the
 * response-splitting sink it usually flows into.
 *
 * One implementation, because every caller is the same open-redirect gate: `redirect()` in
 * `@nifrajs/web`, the `redirectTo` of the `@nifrajs/auth` and `@nifrajs/better-auth` guards. Three
 * copies of a security predicate is three chances for one of them to be hardened alone.
 *
 * It answers about a PATH, not a URL: an absolute `https://this.host/x` is false even for the
 * current origin, because the whole point is that the value never got to name a host.
 */
export function isSameOriginPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false
  // Scanned by character code rather than matched by regex: no control characters have to be written
  // into a pattern, and the check is a single pass over a short string.
  for (let i = 1; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0x5c /* \ */ || code <= 0x1f || code === 0x7f) return false
  }
  return true
}

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

/**
 * The same envelope as {@link jsonError}, as plain data rather than a built `Response`.
 *
 * This is what the framework's own renders - 404, 405, 422, the body caps, the timeouts, 500 - answer
 * with wherever the value flows into a lane's response wrapper, so an error costs what a handler's
 * plain return costs. Building the `Response` was measured as the dominant cost of answering early
 * (see `PlainRender`), and on the Node lane an error `Response` is worse still: it is untagged, so
 * the adapter cannot recognize its body and drains it through a Web stream, which is also why an
 * error answered chunked while an ordinary return carries a `content-length`.
 *
 * `jsonError` stays for the callers that genuinely need a `Response` object (mount bridges, the
 * lanes' own typed returns).
 */
export function plainError(
  status: number,
  error: string,
  headers?: Record<string, string>,
): ResponseResult {
  return statusResult(status, { ok: false, error }, headers !== undefined ? { headers } : undefined)
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

// Extract the pathname WITHOUT a full WHATWG `new URL(req.url)` parse or a temporary `{ pathname,
// search }` pair. The request hot path only needs the path for routing; query extraction remains
// lazy in the request context.
export function pathnameOf(url: string): string {
  const schemeEnd = url.indexOf("://")
  const start = schemeEnd === -1 ? url.indexOf("/") : url.indexOf("/", schemeEnd + 3)
  if (start === -1) return "/"

  let end = url.length
  for (let i = start; i < url.length; i++) {
    const c = url.charCodeAt(i)
    if (c === 63 /* ? */ || c === 35 /* # */) {
      end = i
      break
    }
  }
  return url.slice(start, end)
}
