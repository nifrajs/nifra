import type { BuildManifest } from "../build-plan.ts"
import type { CssLoadingMode } from "../css-contract.ts"

// ---------------------------------------------------------------------------------------------------
// Server-manifest drift detection (#7). `server-manifest.ts` is a committed generated file: it bakes
// the route list + the client-entry hash for a disk-less worker (`generateServerManifest`). If `routes/`
// changes but the manifest isn't regenerated, the worker serves a stale route table - a silent edge
// break. These pure helpers diff the COMMITTED manifest source against the freshly-discovered routes so
// `nifra check` (and `buildServer`) can fail with a named, actionable error before the drift ships.
// ---------------------------------------------------------------------------------------------------

/** A drift finding between a committed server-manifest and the live `routes/` tree. */
export interface ManifestDrift {
  /** Route files present in `routes/` but ABSENT from the committed manifest (the manifest is stale -
   * the new route won't be served by the worker). */
  readonly missing: readonly string[]
  /** Route files the committed manifest imports that no longer exist in `routes/` (a deleted/renamed
   * route still wired into the worker - a build/runtime break). */
  readonly extra: readonly string[]
}

// The route-relative file keys the generated manifest's route map declares. Both shapes are matched by
// their VALUE: eager `  "routes/x.tsx": m0,` and lazy `  "routes/x.tsx": () => import("./routes/x"),`.
// The KEY (not the import specifier) is the route identity `discoverRoutes` produces, extension and all;
// the import specifier is emitted extensionless (so a bare `tsc` compiles the manifest) and could not be
// mapped back to the exact `.tsx`/`.ts` key. The baked `routeStyles` JSON is a single line, so its keys
// are never at an indented line start and never match. `[ \t]+` (not `\s+`) so the `m` anchor stays on
// the same line and one route-map entry cannot span two lines of source.
const MANIFEST_ROUTE_ENTRY = /^[ \t]+(["'])([^"'\n]+)\1\s*:\s*(?:m\d+\b|\(\s*\)\s*=>\s*import\b)/gm
// The baked client-entry line: `export const clientEntry = "…"`.
const MANIFEST_CLIENT_ENTRY = /export\s+const\s+clientEntry\s*=\s*["']([^"']+)["']/
// The baked stylesheet activation line: `generateServerManifest` emits this after the style maps.
const MANIFEST_CSS_LOADING = /export\s+const\s+cssLoading\s*=\s*["'](blocking|deferred)["']/

/**
 * Extract the route-relative file list a committed server-manifest declares, as the same
 * `routes/`-relative keys `discoverRoutes` produces (e.g. `docs/index.tsx`). Reads the route map's KEYS,
 * which carry the file extension and no directory prefix - exactly discovery's shape - so the result is
 * independent of the specifier prefix the manifest happened to import with. The `@nifrajs/web` import and
 * the baked `clientEntry`/`styles`/`routeStyles` lines carry no route-map entry and are ignored.
 *
 * `_routesPrefix` is accepted for call-site compatibility but no longer needed: the keys are already
 * prefix-free. Pure - operates on source text.
 */
export function parseManifestRouteFiles(source: string, _routesPrefix?: string): string[] {
  const files = new Set<string>()
  for (const match of source.matchAll(MANIFEST_ROUTE_ENTRY)) {
    if (match[2] !== undefined) files.add(match[2])
  }
  return [...files].sort()
}

/** The baked `clientEntry` URL in a committed server-manifest, or `undefined` if absent. Pure. */
export function parseManifestClientEntry(source: string): string | undefined {
  return MANIFEST_CLIENT_ENTRY.exec(source)?.[1]
}

/** The baked framework stylesheet activation mode, or `undefined` for an older manifest. Pure. */
export function parseManifestCssLoading(source: string): CssLoadingMode | undefined {
  const value = MANIFEST_CSS_LOADING.exec(source)?.[1]
  return value === "blocking" || value === "deferred" ? value : undefined
}

// The baked asset lines `generateServerManifest` emits: `export const styles = […]` then
// `export const routeStyles = {…}`, each a JSON literal running to the next `export const`. Extracted
// with `indexOf` slicing rather than a lazy `[\s\S]*?` regex: the slice is multi-line by nature (a
// formatter can wrap a long `routeStyles` map, and missing it would silently DROP every baked
// stylesheet on re-sync), and a lazy scan re-walks the file per unterminated opener - quadratic.
function bakedManifestLiteral(source: string, name: string): string | undefined {
  const opener = `export const ${name} = `
  const start = source.indexOf(opener)
  if (start === -1) return undefined
  const from = start + opener.length
  const end = source.indexOf("\nexport const ", from)
  return source.slice(from, end === -1 ? source.length : end).trim()
}

/** Parse a baked JSON literal captured from a committed manifest, tolerating a formatter's TRAILING COMMAS
 * (biome/prettier add one when wrapping a multi-line array/object; strict `JSON.parse` would reject it).
 * Only a comma immediately before a closing `]`/`}` is stripped, so commas inside string values are safe. */
function parseManifestLiteral(raw: string): unknown {
  return JSON.parse(raw.replace(/,(\s*[\]}])/g, "$1"))
}

/** Every file a client build emitted, by request path: its `assets` and the `public/` files it copied. */
export function buildAssetPaths(client: BuildManifest): string[] {
  return [...new Set([...client.assets, ...(client.publicFiles ?? [])])].sort()
}

/** The baked `buildAssets` set in a committed server-manifest, or `undefined` when it bakes none. Pure. */
export function parseManifestBuildAssets(source: string): string[] | undefined {
  const opener = "export const buildAssets: ReadonlySet<string> = new Set("
  const start = source.indexOf(opener)
  if (start === -1) return undefined
  const from = start + opener.length
  const end = source.indexOf("\nexport const ", from)
  const raw = source.slice(from, end === -1 ? source.length : end).trim()
  if (!raw.endsWith(")")) return undefined
  try {
    const value = parseManifestLiteral(raw.slice(0, -1))
    return Array.isArray(value) && value.every((path) => typeof path === "string")
      ? value
      : undefined
  } catch {
    return undefined
  }
}

/** The baked top-level `styles` array in a committed server-manifest (empty if absent/unparseable). Pure. */
export function parseManifestStyles(source: string): string[] {
  const raw = bakedManifestLiteral(source, "styles")
  if (raw === undefined) return []
  try {
    const value: unknown = parseManifestLiteral(raw)
    if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string"))
      return []
    return value
  } catch {
    return []
  }
}

/** The baked per-route `routeStyles` map in a committed server-manifest (empty if absent/unparseable). Pure. */
export function parseManifestRouteStyles(source: string): Record<string, string[]> {
  const raw = bakedManifestLiteral(source, "routeStyles")
  if (raw === undefined) return {}
  try {
    const value: unknown = parseManifestLiteral(raw)
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
    const styles: Record<string, string[]> = {}
    for (const [route, entries] of Object.entries(value)) {
      if (
        !Array.isArray(entries) ||
        !entries.every((item): item is string => typeof item === "string")
      )
        return {}
      styles[route] = entries
    }
    return styles
  } catch {
    return {}
  }
}

/** The baked `copyChunks` map in a committed server-manifest, or `undefined` when it has none. Pure. */
export function parseManifestCopyChunks(source: string): Record<string, string> | undefined {
  const raw = bakedManifestLiteral(source, "copyChunks")
  if (raw === undefined) return undefined
  try {
    const value: unknown = parseManifestLiteral(raw)
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
    const urls: Record<string, string> = {}
    for (const [locale, url] of Object.entries(value))
      if (typeof url === "string") urls[locale] = url
    return urls
  } catch {
    return undefined
  }
}

/**
 * Diff the route files a committed server-manifest imports against the files freshly discovered in
 * `routes/`. Returns the `missing` (in routes/, not in manifest - stale manifest) and `extra` (in
 * manifest, gone from routes/ - dangling import) sets. Empty arrays ⇒ in sync. Pure - the caller
 * supplies both file lists (the committed source is parsed via {@link parseManifestRouteFiles}; the
 * fresh list comes from `discoverRoutes`). Lists need not be pre-sorted; the result is sorted.
 */
export function diffManifestRoutes(
  manifestFiles: readonly string[],
  discoveredFiles: readonly string[],
): ManifestDrift {
  const inManifest = new Set(manifestFiles)
  const inRoutes = new Set(discoveredFiles)
  return {
    missing: discoveredFiles.filter((file) => !inManifest.has(file)).sort(),
    extra: manifestFiles.filter((file) => !inRoutes.has(file)).sort(),
  }
}

/** True when a drift report is clean (no missing + no extra routes). */
export function isManifestInSync(drift: ManifestDrift): boolean {
  return drift.missing.length === 0 && drift.extra.length === 0
}

/**
 * Format a {@link ManifestDrift} as a named, actionable error message, or `undefined` when in sync.
 * Names the exact missing/extra routes + the one fix (regenerate the manifest by re-running the build).
 * `manifestPath` is shown for the dev to locate the stale file. Pure.
 */
export function formatManifestDrift(
  drift: ManifestDrift,
  manifestPath = "server-manifest.ts",
): string | undefined {
  if (isManifestInSync(drift)) return undefined
  const lines = [
    `[nifra/web] server-manifest drift - \`${manifestPath}\` is out of sync with routes/.`,
  ]
  if (drift.missing.length > 0) {
    lines.push(
      `  Missing (in routes/, not in the manifest - these routes won't be served): ${drift.missing.join(", ")}`,
    )
  }
  if (drift.extra.length > 0) {
    lines.push(
      `  Extra (imported by the manifest, gone from routes/ - a dangling import): ${drift.extra.join(", ")}`,
    )
  }
  lines.push("  Fix: re-run the build to regenerate the server manifest, then commit it.")
  return lines.join("\n")
}
