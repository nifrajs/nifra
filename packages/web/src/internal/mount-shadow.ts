/**
 * Page routes a mount makes unreachable.
 *
 * A pre-route mount (the auto-mounted backend at `apiPrefix`, a `mounts` entry, an `app.mount()` in
 * `use`) answers every request under its path before page routing, and its 404 is final -
 * `fallbackOn: 404` only tries the next mount. A page file whose URL sits under one therefore never
 * renders, and nothing says so: the request gets the mount's 404. This finds those pages so the app
 * fails at startup, at build, and in `nifra check` instead.
 *
 * Pure and fs-free: it takes the manifest and the mount paths, so the runtime, the build and the static
 * check all run the same comparison.
 */
import type { Manifest } from "../manifest.ts"

/** A page file whose URL pattern sits under a mount. */
export interface ShadowedPage {
  /** The route file, as the manifest names it (relative to `routes/`). */
  readonly file: string
  /** The URL pattern the file serves. */
  readonly pattern: string
  /** The mount path, normalized as the server matches it. */
  readonly mount: string
}

/**
 * Normalize a mount path the way the server's mount table does: drop a trailing `/*` and a trailing
 * `/`, keep `/` for a root mount. `undefined` for a path the server would refuse (not absolute, a
 * query or hash, a param or an inner wildcard) - the mount itself reports that.
 */
export function normalizeMountPath(path: string): string | undefined {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) return undefined
  const bare = path.endsWith("/*") ? path.slice(0, -2) : path
  if (bare.includes("*") || bare.includes(":")) return undefined
  if (bare.length === 0) return "/"
  return bare.length > 1 && bare.endsWith("/") ? bare.slice(0, -1) : bare
}

/** Whether every request a pattern serves lands under `mount`: its leading segments equal the mount's
 * segments literally. A param or wildcard segment is not the mount's literal text, so `/:lang/x` is
 * reachable for every other value and is not reported. */
function patternUnderMount(pattern: string, mount: string): boolean {
  if (mount === "/") return true
  return pattern === mount || pattern.startsWith(`${mount}/`)
}

/**
 * The page routes and nested `_404` scopes that sit under one of `mountPaths`, in manifest order. Paths
 * are normalized here; one the server would refuse is skipped.
 */
export function shadowedPages(
  manifest: Pick<Manifest, "routes" | "notFounds">,
  mountPaths: readonly string[],
): readonly ShadowedPage[] {
  const mounts: string[] = []
  for (const path of mountPaths) {
    const normalized = normalizeMountPath(path)
    if (normalized !== undefined && !mounts.includes(normalized)) mounts.push(normalized)
  }
  if (mounts.length === 0) return []
  const found: ShadowedPage[] = []
  const under = (pattern: string): string | undefined => {
    for (const mount of mounts) if (patternUnderMount(pattern, mount)) return mount
    return undefined
  }
  for (const route of manifest.routes) {
    const mount = under(route.pattern)
    if (mount !== undefined) found.push({ file: route.file, pattern: route.pattern, mount })
  }
  for (const entry of Object.values(manifest.notFounds ?? {})) {
    for (const scope of entry.scopes) {
      const mount = under(scope.pattern)
      if (mount !== undefined) found.push({ file: entry.file, pattern: scope.pattern, mount })
    }
  }
  return found
}

/** The message every surface reports shadowed pages with. */
export function formatShadowedPages(pages: readonly ShadowedPage[]): string {
  const lines = pages.map(
    (page) => `  ${page.file} serves ${page.pattern}, under the mount at ${page.mount}`,
  )
  return (
    `${pages.length === 1 ? "1 page route" : `${pages.length} page routes`} can never render: a mount answers every request under its path before page routing, and its 404 is final.\n` +
    `${lines.join("\n")}\n` +
    'Move each file out of the mounted path, or serve that URL from the mounted app. The backend\'s mount path is `apiPrefix` (default "/api"; export it from framework.ts, or set it to "" to turn the mount off).'
  )
}
