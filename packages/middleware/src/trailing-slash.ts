import { definePlugin } from "@nifrajs/core/server"

export interface TrailingSlashOptions {
  /** Redirect (default) or route internally with a rewritten URL. */
  readonly mode?: "redirect" | "rewrite"
  /** Redirect status. Default `308` (method-preserving permanent redirect). */
  readonly status?: 301 | 302 | 307 | 308
  /** Methods affected. Default `["GET", "HEAD"]`; add write methods only when you want 308 redirects. */
  readonly methods?: readonly string[]
  /** Skip paths whose last segment looks like a file (`/app.css`). Default `true` for append mode. */
  readonly ignoreFileExtensions?: boolean
  /** App-specific skip predicate. */
  readonly ignore?: (path: string, request: Request) => boolean
}

const DEFAULT_METHODS = ["GET", "HEAD"] as const
const REDIRECT_STATUSES = new Set([301, 302, 307, 308])

function validateStatus(status: number): asserts status is 301 | 302 | 307 | 308 {
  if (!REDIRECT_STATUSES.has(status)) {
    throw new Error("trailingSlash: status must be 301, 302, 307, or 308")
  }
}

function hasFileExtension(path: string): boolean {
  const slash = path.lastIndexOf("/")
  const segment = path.slice(slash + 1)
  return segment.includes(".")
}

function withPath(req: Request, path: string): URL {
  const url = new URL(req.url)
  url.pathname = path
  return url
}

function route(
  req: Request,
  url: URL,
  mode: "redirect" | "rewrite",
  status: 301 | 302 | 307 | 308,
) {
  return mode === "rewrite"
    ? new Request(url.toString(), req)
    : new Response(null, { status, headers: { location: url.toString() } })
}

function methodsOf(methods: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()))
}

/**
 * Remove trailing slashes from non-root paths. Redirect mode is the production default because it
 * canonicalizes URLs for clients and caches; rewrite mode is available for compatibility migrations.
 */
export function trimTrailingSlash(options: TrailingSlashOptions = {}) {
  const mode = options.mode ?? "redirect"
  const status = options.status ?? 308
  validateStatus(status)
  const methods = methodsOf(options.methods)

  return definePlugin("trimTrailingSlash", (app) =>
    app.onRequest((req) => {
      if (!methods.has(req.method.toUpperCase())) return undefined
      const path = new URL(req.url).pathname
      if (path === "/" || !path.endsWith("/")) return undefined
      if (options.ignore?.(path, req) === true) return undefined
      return route(req, withPath(req, path.replace(/\/+$/, "") || "/"), mode, status)
    }),
  )
}

/**
 * Append a trailing slash to non-root paths. By default it skips file-looking paths such as
 * `/app.css`, which keeps static assets and extensionful API routes stable.
 */
export function appendTrailingSlash(options: TrailingSlashOptions = {}) {
  const mode = options.mode ?? "redirect"
  const status = options.status ?? 308
  const ignoreFileExtensions = options.ignoreFileExtensions !== false
  validateStatus(status)
  const methods = methodsOf(options.methods)

  return definePlugin("appendTrailingSlash", (app) =>
    app.onRequest((req) => {
      if (!methods.has(req.method.toUpperCase())) return undefined
      const path = new URL(req.url).pathname
      if (path === "/" || path.endsWith("/")) return undefined
      if (ignoreFileExtensions && hasFileExtension(path)) return undefined
      if (options.ignore?.(path, req) === true) return undefined
      return route(req, withPath(req, `${path}/`), mode, status)
    }),
  )
}
