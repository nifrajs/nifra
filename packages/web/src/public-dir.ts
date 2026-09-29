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
import { constants as FS } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { extname, normalize, resolve, sep } from "node:path"
import { Readable } from "node:stream"
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

/**
 * Media types by extension. A table rather than `Bun.file(path).type`: this handler also runs on the
 * Node and Deno adapters, where `Bun` does not exist and every hit would throw. Unknown extensions
 * (and extensionless files such as ACME tokens) are served as `application/octet-stream`, which
 * together with `nosniff` keeps the browser from guessing a more dangerous type.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml",
  ".rss": "application/rss+xml",
  ".atom": "application/atom+xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".vtt": "text/vtt; charset=utf-8",
}

/**
 * Whether a confined path crosses a dot-segment other than `.well-known`. The build copies `public/`
 * with dotfiles included, so an editor or VCS artifact (`.env`, `.git/`, `.DS_Store`) dropped there
 * would otherwise be downloadable. Checked on the resolved path, so `%2e` encodings are covered.
 */
function isHiddenPath(root: string, abs: string): boolean {
  for (const segment of abs.slice(root.length + 1).split(sep)) {
    if (segment.startsWith(".") && segment !== ".well-known") return true
  }
  return false
}

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
    if (abs === undefined || isHiddenPath(root, abs)) return undefined
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
    // Open the canonical path once and stream from that descriptor. Reopening the pathname after
    // realpath containment checks would let a writable public tree swap a symlink between validation
    // and the actual read. O_NOFOLLOW also rejects a final-component symlink if one appears before
    // the open; the descriptor then pins the bytes for the lifetime of the response.
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(resolvedFile, FS.O_RDONLY | FS.O_NOFOLLOW)
      const stat = await handle.stat()
      if (!stat.isFile()) return undefined
      const size = stat.size
      const headers = new Headers({
        "cache-control": pathname.startsWith(hashedPrefix) ? hashed : assets,
        // Advertised unconditionally: a client that never sees `accept-ranges` will not attempt a seek,
        // so a video or audio file under `public/` is scrubbable only once this header is present.
        "accept-ranges": "bytes",
        // Never let a client sniff a served file into a more dangerous type (an upload-like `.txt`
        // rendered as HTML, say). The declared type below is authoritative.
        "x-content-type-options": "nosniff",
        // Set explicitly rather than inferred from the body, so HEAD (a null body) carries it too.
        "content-type":
          CONTENT_TYPES[extname(resolvedFile).toLowerCase()] ?? "application/octet-stream",
      })
      const lastModified =
        Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0 ? stat.mtimeMs : undefined
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

      const body = (start?: number, end?: number): ReadableStream<Uint8Array> => {
        const stream = handle!.createReadStream({ start, end })
        // FileHandle.createReadStream owns closing the descriptor after EOF/abort.
        handle = undefined
        return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
      }

      if (range.kind === "satisfiable" && range.ranges.length === 1) {
        const { start, end } = range.ranges[0]!
        headers.set("content-range", `bytes ${start}-${end}/${size}`)
        headers.set("content-length", String(end - start + 1))
        return new Response(head ? null : body(start, end), { status: 206, headers })
      }

      // Multiple ranges would require assembling `multipart/byteranges`, and doing that for a file on
      // disk means buffering the whole representation to serve a request that asked for less of it.
      // RFC 9110 lets a server ignore Range entirely, so the full body is the conformant answer here.
      headers.set("content-length", String(size))
      return new Response(head ? null : body(), { headers })
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch {
          // Closing a descriptor is best-effort after the response decision is made.
        }
      }
    }
  }
}
