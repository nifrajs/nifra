/**
 * `public/` - user-authored static files, served identically in dev and in production.
 *
 * The asymmetry this closes: `nifra dev` served `public/` for free because the HMR path runs on Vite
 * and Vite serves `public/` by default, while production had no `publicDir` concept at all. So a file
 * worked all the way through development and 404'd the moment it was deployed. The failure is
 * inverted - it appears only in production, and only for the assets nobody smoke-tests - and it has
 * already shipped once as a self-hosted webfont that silently fell back to a system font in prod.
 *
 * One owner for both sides is the fix, not a second implementation that happens to agree today.
 *
 * Distinct from `publicPath` in `build.ts`, which is the URL prefix for content-hashed bundle chunks.
 * The names collide and the concepts do not: `publicPath` never covers user-authored files.
 */
import { realpath } from "node:fs/promises"
import { normalize, resolve, sep } from "node:path"
import { parseByteRange } from "@nifrajs/core/range"
import { pathnameOf } from "@nifrajs/core/server"

/** How long each subtree may be cached. Content-hashed bundle output can be immutable; a
 * user-authored file keeps its name across deploys, so it gets a day and a revalidation. */
export interface PublicDirCache {
  /** `cache-control` for content-hashed assets (default immutable, one year). */
  readonly hashed?: string
  /** `cache-control` for everything else under `public/` (default one day). */
  readonly assets?: string
}

export interface ServePublicDirOptions {
  /** Absolute path of the directory to serve. */
  readonly dir: string
  /** URL prefix whose files are content-hashed and may be cached immutably (default `"/assets/"`). */
  readonly hashedPrefix?: string
  readonly cache?: PublicDirCache
  /** Optional encoded URL-path allowlist. When present, route misses avoid a filesystem probe. */
  readonly files?: ReadonlySet<string>
}

const IMMUTABLE = "public, max-age=31536000, immutable"
const ONE_DAY = "public, max-age=86400"

/** HTTP dates carry second precision; comparing raw milliseconds makes every file look stale. */
function seconds(time: number): number {
  return Math.floor(time / 1000)
}

/**
 * `If-Range` decides whether a range request is still safe to answer partially. The only validator
 * this handler publishes is `last-modified`, so an entity-tag form can never match and the whole
 * representation is sent instead - which is the conformant outcome, not a fallback. Dates use strong
 * comparison (RFC 9110 13.1.5): a file modified since the client's copy invalidates its byte offsets.
 */
function ifRangeMatches(value: string | null, lastModified: number | undefined): boolean {
  if (value === null) return true
  if (lastModified === undefined) return false
  const item = value.trim()
  if (item.startsWith('"') || item.startsWith("W/")) return false
  const parsed = Date.parse(item)
  return Number.isFinite(parsed) && seconds(parsed) === seconds(lastModified)
}

/** `If-Modified-Since` freshness. No ETag is published, so there is no `If-None-Match` precedence. */
function isNotModified(request: Request, lastModified: number | undefined): boolean {
  if (lastModified === undefined) return false
  const since = request.headers.get("if-modified-since")
  if (since === null) return false
  const parsed = Date.parse(since)
  return Number.isFinite(parsed) && seconds(parsed) >= seconds(lastModified)
}

/**
 * Resolve a URL pathname to an absolute path **confined** to `root`, or `undefined` if it escapes.
 *
 * This is a user-path-to-filesystem sink, which makes it the one part of this feature with a security
 * consequence. Decode first (`%2e%2e%2f` is `../`), then normalize, then verify the result is still
 * under `root` by prefix - checking the *resolved* path rather than scanning the input for `..`,
 * because a blocklist over encodings is exactly the kind of check that gets bypassed.
 */
export function resolvePublicPath(root: string, pathname: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined // malformed percent-encoding: not a path we will guess at
  }
  // A NUL can truncate a path in a downstream syscall; refuse rather than normalize it away.
  if (decoded.includes("\0")) return undefined
  const rootResolved = resolve(root)
  const candidate = resolve(rootResolved, `.${normalize(decoded)}`)
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) return undefined
  return candidate
}

/**
 * Build a static-file handler for `dir`.
 *
 * Returns `undefined` on any miss so the caller **falls through to routing** - a static probe must
 * never shadow a route. That ordering is also why a `routes/robots.txt.tsx` beats a
 * `public/robots.txt` only if the caller checks routes first; the documented precedence is that the
 * static probe runs first, so `public/` wins, and an app wanting the route should not ship both.
 */
export function servePublicDir(
  options: ServePublicDirOptions,
): (request: Request) => Promise<Response | undefined> {
  const root = resolve(options.dir)
  const rootReal = realpath(root).catch(() => undefined)
  const hashedPrefix = options.hashedPrefix ?? "/assets/"
  const hashed = options.cache?.hashed ?? IMMUTABLE
  const assets = options.cache?.assets ?? ONE_DAY

  return async (request: Request): Promise<Response | undefined> => {
    if (request.method !== "GET" && request.method !== "HEAD") return undefined
    // Request URLs are absolute and already normalized by the host runtime. The lightweight splitter
    // avoids a WHATWG URL allocation on every asset hit; resolvePublicPath below still performs the
    // decode, NUL, normalization, confinement, and realpath checks that protect this filesystem sink.
    const pathname = pathnameOf(request.url)
    // A production manifest can reject page routes without touching the filesystem.
    if (options.files !== undefined && !options.files.has(pathname)) return undefined
    const abs = resolvePublicPath(root, pathname)
    if (abs === undefined) return undefined
    const [resolvedRoot, resolvedFile] = await Promise.all([
      rootReal,
      realpath(abs).catch(() => undefined),
    ])
    if (
      resolvedRoot === undefined ||
      resolvedFile === undefined ||
      (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(resolvedRoot + sep))
    ) {
      return undefined
    }
    const file = Bun.file(resolvedFile)
    if (!(await file.exists())) return undefined
    const size = file.size
    const headers = new Headers({
      "cache-control": pathname.startsWith(hashedPrefix) ? hashed : assets,
      // Advertised unconditionally: a client that never sees `accept-ranges` will not attempt a seek,
      // so a video or audio file under `public/` is scrubbable only once this header is present.
      "accept-ranges": "bytes",
    })
    // `new Response(file)` used to infer the media type, which meant HEAD - built from a null body -
    // silently lost it. Setting it here is what makes the two methods agree.
    if (file.type !== "") headers.set("content-type", file.type)
    const lastModified =
      Number.isFinite(file.lastModified) && file.lastModified > 0 ? file.lastModified : undefined
    if (lastModified !== undefined) {
      headers.set("last-modified", new Date(lastModified).toUTCString())
    }
    const head = request.method === "HEAD"

    if (isNotModified(request, lastModified)) {
      headers.delete("content-type")
      return new Response(null, { status: 304, headers })
    }

    const rangeHeader = request.headers.get("range")
    const range =
      rangeHeader !== null && ifRangeMatches(request.headers.get("if-range"), lastModified)
        ? parseByteRange(rangeHeader, size)
        : ({ kind: "none" } as const)

    if (range.kind === "unsatisfiable") {
      headers.delete("content-type")
      headers.set("content-range", `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }

    if (range.kind === "satisfiable" && range.ranges.length === 1) {
      const { start, end } = range.ranges[0]!
      headers.set("content-range", `bytes ${start}-${end}/${size}`)
      headers.set("content-length", String(end - start + 1))
      // `slice` keeps the read lazy: only the selected window is ever pulled off disk.
      return new Response(head ? null : file.slice(start, end + 1), { status: 206, headers })
    }

    // Multiple ranges would require assembling `multipart/byteranges`, and doing that for a file on
    // disk means buffering the whole representation to serve a request that asked for less of it.
    // RFC 9110 lets a server ignore Range entirely, so the full body is the conformant answer here.
    if (head) headers.set("content-length", String(size))
    return new Response(head ? null : file, { headers })
  }
}
