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
import { createHash } from "node:crypto"
import { type FileHandle, realpath } from "node:fs/promises"
import { normalize, resolve, sep } from "node:path"
import { Readable } from "node:stream"
import { parseByteRange } from "@nifrajs/core/range"
import { pathnameOf } from "@nifrajs/core/server"
import {
  CONTENT_SNAPSHOT_MAX,
  contentTags,
  contentTypeOf,
  ifRangeAllowsPartial,
  isHiddenPath,
  isNotModified,
  lastModifiedOf,
  streamedLastModifiedOf,
} from "@nifrajs/core/static-file"
import { openResolved } from "./open-resolved.ts"

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
  /** URL prefix whose files are content-hashed and may be cached immutably (default `"/assets/"`).
   * Ignored when `hashedFiles` is set. */
  readonly hashedPrefix?: string
  /**
   * Encoded URL paths of the content-hashed files, such as a build manifest's `assets`. When set, only
   * these are cached immutably and every other file gets the `assets` policy, so a user-authored file
   * that happens to sit under the hashed prefix still revalidates.
   */
  readonly hashedFiles?: ReadonlySet<string>
  readonly cache?: PublicDirCache
  /** Optional encoded URL-path allowlist. When present, route misses avoid a filesystem probe. */
  readonly files?: ReadonlySet<string>
}

export const IMMUTABLE = "public, max-age=31536000, immutable"
export const ONE_DAY = "public, max-age=86400"

/**
 * Whether a confined path crosses a hidden segment ({@link isHiddenPath}). Checked on the
 * resolved path, so `%2e` encodings are covered, and again on the real target, so a visible name
 * linking to `.env` is refused too.
 */
function hiddenUnder(root: string, abs: string): boolean {
  return abs !== root && isHiddenPath(abs.slice(root.length + 1))
}

// Up to this many bytes are read whole through the pinned descriptor, which then closes before the
// response leaves: on Bun a 200 KB asset is served in 0.17 ms against 0.28 ms through a node:fs
// stream. A larger body streams, so a video holds a stream's buffer per request rather than the file.
const BUFFERED_BODY_MAX = CONTENT_SNAPSHOT_MAX
// Bun.serve drops the declared length of any stream body and sends it chunked, and a Bun.file body
// would need this descriptor open for a send nothing reports the end of. So on Bun a body up to 1 MiB
// is read whole as well: a slow client then holds ~1 MB, against ~0.6 MB through Bun's stream sink.
const BUN_BUFFERED_BODY_MAX = 1024 * 1024

// One per process: the tag of a file served by any handler is remembered by its real path.
const TAGS = contentTags(createHash)

/** `length` bytes of `handle` from `start`; fewer when the file shrank since its stat. */
async function readPinned(
  handle: FileHandle,
  start: number,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, start + offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return offset === length ? bytes : bytes.subarray(0, offset)
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
 *
 * Files up to 256 KiB carry a strong `ETag` from the exact snapshot served, matching the Node and
 * Deno readers. Those snapshots carry `Last-Modified` only while mtime reflects their own last change.
 * Larger files stream without an `ETag`: an open inode can change after a separate hash pass. They
 * are dated once settled, but an `If-Range` request gets the whole file rather than spliced versions.
 */
export function servePublicDir(
  options: ServePublicDirOptions,
): (request: Request) => Promise<Response | undefined> {
  const root = resolve(options.dir)
  const rootReal = realpath(root).catch(() => undefined)
  const hashedPrefix = options.hashedPrefix ?? "/assets/"
  const hashedFiles = options.hashedFiles
  const hashed = options.cache?.hashed ?? IMMUTABLE
  const assets = options.cache?.assets ?? ONE_DAY
  const bufferedMax = typeof Bun === "undefined" ? BUFFERED_BODY_MAX : BUN_BUFFERED_BODY_MAX

  return async (request: Request): Promise<Response | undefined> => {
    if (request.method !== "GET" && request.method !== "HEAD") return undefined
    // Request URLs are absolute and already normalized by the host runtime. The lightweight splitter
    // avoids a WHATWG URL allocation on every asset hit; resolvePublicPath below still performs the
    // decode, NUL, normalization, confinement, and realpath checks that protect this filesystem sink.
    const pathname = pathnameOf(request.url)
    // A production manifest can reject page routes without touching the filesystem.
    if (options.files !== undefined && !options.files.has(pathname)) return undefined
    const abs = resolvePublicPath(root, pathname)
    if (abs === undefined || hiddenUnder(root, abs)) return undefined
    const [resolvedRoot, resolvedFile] = await Promise.all([
      rootReal,
      realpath(abs).catch(() => undefined),
    ])
    if (
      resolvedRoot === undefined ||
      resolvedFile === undefined ||
      (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(resolvedRoot + sep)) ||
      hiddenUnder(resolvedRoot, resolvedFile)
    ) {
      return undefined
    }
    // Open the canonical path once and stream from that descriptor. Reopening the pathname after
    // realpath containment checks would let a writable public tree swap a symlink between validation
    // and the actual read. openResolved also refuses the name once any component of it became a
    // symlink; the descriptor then pins the bytes for the lifetime of the response.
    let handle: Awaited<ReturnType<typeof openResolved>> | undefined
    try {
      let file: FileHandle
      try {
        file = await openResolved(resolvedFile)
      } catch {
        // A name refused or gone since realpath falls through, as a failed realpath does.
        return undefined
      }
      handle = file
      const stat = await file.stat()
      if (!stat.isFile()) return undefined
      const size = stat.size
      const headers = new Headers({
        "cache-control": (
          hashedFiles === undefined
            ? pathname.startsWith(hashedPrefix)
            : hashedFiles.has(pathname)
        )
          ? hashed
          : assets,
        // Advertised unconditionally: a client that never sees `accept-ranges` will not attempt a seek,
        // so a video or audio file under `public/` is scrubbable only once this header is present.
        "accept-ranges": "bytes",
        // Never let a client sniff a served file into a more dangerous type (an upload-like `.txt`
        // rendered as HTML, say). The declared type below is authoritative.
        "x-content-type-options": "nosniff",
        // Set explicitly rather than inferred from the body, so HEAD (a null body) carries it too.
        "content-type": contentTypeOf(resolvedFile),
      })
      // The whole file, when tagging it had to read it: the response is then served from these bytes.
      let whole: Uint8Array<ArrayBuffer> | undefined
      let etag: string | undefined
      if (size <= CONTENT_SNAPSHOT_MAX) {
        whole = await readPinned(file, 0, size)
        etag = await TAGS.ofSnapshot(resolvedFile, stat, whole, () => file.stat())
      }
      if (etag !== undefined) headers.set("etag", etag)
      const lastModified = whole === undefined ? streamedLastModifiedOf(stat) : lastModifiedOf(stat)
      if (lastModified !== undefined) {
        headers.set("last-modified", new Date(lastModified).toUTCString())
      }
      const head = request.method === "HEAD"

      if (
        isNotModified(
          request.headers.get("if-none-match"),
          request.headers.get("if-modified-since"),
          etag,
          lastModified,
        )
      ) {
        headers.delete("content-type")
        return new Response(null, { status: 304, headers })
      }

      // Range applies to GET only (RFC 9110 section 14.2); HEAD reports the whole representation.
      const rangeHeader = head ? null : request.headers.get("range")
      // A streamed body's date is weak: a write during the stream must never splice two versions.
      const range =
        rangeHeader !== null &&
        ifRangeAllowsPartial(
          request.headers.get("if-range"),
          etag,
          whole === undefined ? undefined : lastModified,
        )
          ? parseByteRange(rangeHeader, size)
          : ({ kind: "none" } as const)

      if (range.kind === "unsatisfiable") {
        headers.delete("content-type")
        headers.set("content-range", `bytes */${size}`)
        return new Response(null, { status: 416, headers })
      }

      const body = async (
        start: number,
        end: number,
      ): Promise<Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>> => {
        const length = end - start + 1
        if (length <= bufferedMax) {
          const bytes =
            whole === undefined
              ? await readPinned(file, start, length)
              : whole.subarray(start, start + length)
          headers.set("content-length", String(bytes.byteLength))
          return bytes
        }
        const stream = file.createReadStream({ start, end })
        // FileHandle.createReadStream owns closing the descriptor after EOF/abort.
        handle = undefined
        return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
      }

      if (range.kind === "satisfiable" && range.ranges.length === 1) {
        const { start, end } = range.ranges[0]!
        headers.set("content-range", `bytes ${start}-${end}/${size}`)
        headers.set("content-length", String(end - start + 1))
        return new Response(head ? null : await body(start, end), { status: 206, headers })
      }

      // Multiple ranges would require assembling `multipart/byteranges`, and doing that for a file on
      // disk means buffering the whole representation to serve a request that asked for less of it.
      // RFC 9110 lets a server ignore Range entirely, so the full body is the conformant answer here.
      headers.set("content-length", String(size))
      return new Response(head || size === 0 ? null : await body(0, size - 1), { headers })
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

export interface PrerenderedPageReaderOptions {
  /** Absolute path of the directory the build wrote the prerendered pages into. */
  readonly dir: string
  /** Each page path mapped to its file, relative to `dir`. */
  readonly files: Readonly<Record<string, string>>
  /** Bytes of HTML kept in memory once read (default 32 MiB); a page past the budget is read per request. */
  readonly cacheBytes?: number
}

/**
 * Read a self-hosted build's prerendered pages for `createWebApp`'s `prerenderedPages`. Only the build's
 * own files are reachable, each opened only once its real path is inside `dir`, so a link planted in the
 * deployed tree cannot point a page elsewhere. A deploy's files do not change while it runs, so a page
 * is kept after its first read; `undefined` (a missing or refused file) renders the page on demand.
 */
export function prerenderedPageReader(
  options: PrerenderedPageReaderOptions,
): (pathname: string) => Promise<string | undefined> {
  const root = resolve(options.dir)
  const rootReal = realpath(root).catch(() => undefined)
  const files = new Map(Object.entries(options.files))
  const budget = options.cacheBytes ?? 32 * 1024 * 1024
  const cache = new Map<string, string>()
  let cachedBytes = 0
  return async (pathname) => {
    const cached = cache.get(pathname)
    if (cached !== undefined) return cached
    const rel = files.get(pathname)
    if (rel === undefined) return undefined
    const abs = resolve(root, rel)
    if (!abs.startsWith(root + sep) || hiddenUnder(root, abs)) return undefined
    const [resolvedRoot, resolvedFile] = await Promise.all([
      rootReal,
      realpath(abs).catch(() => undefined),
    ])
    if (
      resolvedRoot === undefined ||
      resolvedFile === undefined ||
      !resolvedFile.startsWith(resolvedRoot + sep)
    ) {
      return undefined
    }
    let handle: FileHandle
    try {
      handle = await openResolved(resolvedFile)
    } catch {
      return undefined
    }
    try {
      if (!(await handle.stat()).isFile()) return undefined
      const bytes = await handle.readFile()
      const html = bytes.toString("utf8")
      if (!cache.has(pathname) && cachedBytes + bytes.byteLength <= budget) {
        cache.set(pathname, html)
        cachedBytes += bytes.byteLength
      }
      return html
    } catch {
      return undefined
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
}
