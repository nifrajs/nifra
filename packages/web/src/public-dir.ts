/**
 * `public/` - user-authored static files, served identically in dev and in production.
 *
 * The asymmetry this closes: `nifra dev` served `public/` for free because the HMR path runs on Vite
 * and Vite serves `public/` by default, while production had no `publicDir` concept at all. So a file
 * worked all the way through development and 404'd the moment it was deployed. Dev and every
 * self-hosting build now serve it through their runtime's `serveStatic`, with the same mounts.
 *
 * Distinct from `publicPath` in `build.ts`, which is the URL prefix for content-hashed bundle chunks.
 * The names collide and the concepts do not: `publicPath` never covers user-authored files.
 */
import { type FileHandle, realpath } from "node:fs/promises"
import { normalize, relative, resolve, sep } from "node:path"
import { decodePathSegment } from "@nifrajs/core/pattern"
import { isHiddenPath } from "@nifrajs/core/static-file"
import { openResolved } from "./open-resolved.ts"

/**
 * Whether a confined path crosses a hidden segment ({@link isHiddenPath}). Checked on the
 * resolved path, so `%2e` encodings are covered, and again on the real target, so a visible name
 * linking to `.env` is refused too.
 */
function hiddenUnder(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel !== "" && isHiddenPath(rel)
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
  const decoded = decodePathSegment(pathname)
  if (decoded === undefined) return undefined // malformed percent-encoding: not a path we will guess at
  // A NUL can truncate a path in a downstream syscall; refuse rather than normalize it away.
  if (decoded.includes("\0")) return undefined
  const rootResolved = resolve(root)
  const candidate = resolve(rootResolved, `.${normalize(decoded)}`)
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) return undefined
  return candidate
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
      !resolvedFile.startsWith(resolvedRoot + sep) ||
      hiddenUnder(resolvedRoot, resolvedFile)
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
