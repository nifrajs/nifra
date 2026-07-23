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
    const { pathname } = new URL(request.url)
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
    const headers = new Headers({
      "cache-control": pathname.startsWith(hashedPrefix) ? hashed : assets,
    })
    // HEAD must not carry a body, but must otherwise match GET's headers.
    return request.method === "HEAD"
      ? new Response(null, { headers })
      : new Response(file, { headers })
  }
}
