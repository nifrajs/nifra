/**
 * `@nifrajs/web/route-manifest` — what each route actually DOES, as one artifact.
 *
 * The facts are already in the route modules: `prerender`, `getStaticPaths`, `revalidate`, `hydrate`.
 * What has never existed is anywhere to read them together. To answer "which pages are static?", "which
 * ones revalidate, and how often?", "which ship no JS?", you open every route file and hold the answer in
 * your head - and the answer changes on the target you deploy to, which is nowhere near the route file.
 *
 * That gap is not just inconvenient. The interesting cases are the ones where a route's declaration and
 * its deploy target disagree, and there is currently nothing that can notice: an ISR route on a target
 * with no revalidation story regenerates on every request; a `static` build containing a route that was
 * never prerenderable ships a page that 404s. Both are silent, and both are decided at build time by
 * information no single place holds.
 *
 * So this derives one record per route - render mode, hydration, cache policy - resolves it against the
 * target, and reports what the target cannot honour. Pure and fs-free: it takes an already-built
 * `Manifest` so it runs at build time, in `nifra routes`, and in a test with a hand-built manifest.
 */
import type { Manifest, RouteModule } from "./manifest.ts"

/**
 * How a route produces its HTML.
 *
 * - `static`  - prerendered at build; served as a file, no server render at request time.
 * - `isr`     - server-rendered, then cached and revalidated on a timer (`export const revalidate`).
 * - `ssr`     - server-rendered per request. The default, and the only mode that needs a live server.
 */
export type RenderMode = "static" | "isr" | "ssr"

/** What a route needs from its host in order to behave as declared. */
export type RouteCapability = "server" | "revalidation"

/** One route's resolved behaviour. */
export interface RouteManifestEntry {
  /** The route's id (its key in the build manifest and in `routes`). */
  readonly id: string
  /** The matching pattern, e.g. `/blog/:slug`. */
  readonly pattern: string
  readonly mode: RenderMode
  /** Whether the full-document client is shipped. `false` means the page loads no framework JS. */
  readonly hydrate: boolean
  /** Revalidation window in seconds. Present only for `isr`. */
  readonly revalidate?: number
  /**
   * Concrete paths prerendered at build. Present for `static` routes: a single path for a static route,
   * one per `getStaticPaths` entry for a dynamic one. Absent means "no path was enumerated", which for a
   * dynamic route is exactly the condition that makes it unprerenderable.
   */
  readonly prerenderedPaths?: readonly string[]
  /** What this route needs from the host to behave as declared. */
  readonly requires: readonly RouteCapability[]
}

/** A route whose declaration the chosen target cannot honour, and what actually happens if it ships. */
export interface RouteManifestConflict {
  readonly id: string
  readonly pattern: string
  readonly capability: RouteCapability
  /** What goes wrong on this target - the consequence, not the rule that was broken. */
  readonly consequence: string
}

/** The whole artifact: every route's behaviour, plus anything the target cannot honour. */
export interface RouteManifest {
  /** The deploy target this was resolved against, when one was given. */
  readonly target?: string
  readonly routes: readonly RouteManifestEntry[]
  readonly conflicts: readonly RouteManifestConflict[]
  /** Route counts by mode - the summary a report leads with. */
  readonly totals: Readonly<Record<RenderMode, number>>
}

/** A route is dynamic when its pattern carries a param or wildcard segment. */
const isDynamic = (pattern: string): boolean => /[:*]/.test(pattern)

/**
 * Derive one route's behaviour from its module exports.
 *
 * `prerender`/`getStaticPaths` win over `revalidate`: a page rendered at build time is not revalidated at
 * runtime, so if a route declares both, the build-time answer is the one that describes what ships. That
 * combination is worth surfacing rather than silently resolving, which is what `conflicts` is for once a
 * target is known.
 */
export function deriveRouteEntry(
  id: string,
  pattern: string,
  module: Pick<RouteModule, "prerender" | "getStaticPaths" | "revalidate" | "hydrate">,
  prerenderedPaths?: readonly string[],
): RouteManifestEntry {
  const wantsPrerender = module.prerender === true || module.getStaticPaths !== undefined
  // A dynamic route is only really static if concrete paths were enumerated for it. `getStaticPaths`
  // declares the intent; the paths are the evidence, and without them there is nothing prerendered to
  // serve. Treating intent as sufficient is how a "static" build ships a page that 404s.
  const enumerated = prerenderedPaths !== undefined && prerenderedPaths.length > 0
  const isStatic = wantsPrerender && (!isDynamic(pattern) || enumerated)
  const mode: RenderMode = isStatic ? "static" : module.revalidate !== undefined ? "isr" : "ssr"

  const requires: RouteCapability[] = []
  if (mode !== "static") requires.push("server")
  if (mode === "isr") requires.push("revalidation")

  const entry: {
    id: string
    pattern: string
    mode: RenderMode
    hydrate: boolean
    revalidate?: number
    prerenderedPaths?: readonly string[]
    requires: readonly RouteCapability[]
  } = { id, pattern, mode, hydrate: module.hydrate !== false, requires }
  if (mode === "isr" && module.revalidate !== undefined) entry.revalidate = module.revalidate
  if (prerenderedPaths !== undefined) entry.prerenderedPaths = prerenderedPaths
  return entry as RouteManifestEntry
}

/**
 * What each deploy target can actually do.
 *
 * `static` is the one that matters: it has no server at all, so every non-prerendered route is a page
 * that will 404 in production while working perfectly in dev. The rest all run a server; they differ in
 * how revalidation is wired, not in whether it exists, so this deliberately does not invent finer
 * distinctions it cannot verify.
 */
const TARGET_CAPABILITIES: Readonly<Record<string, readonly RouteCapability[]>> = {
  bun: ["server", "revalidation"],
  node: ["server", "revalidation"],
  deno: ["server", "revalidation"],
  "cf-pages": ["server", "revalidation"],
  vercel: ["server", "revalidation"],
  static: [],
}

const CONSEQUENCE: Readonly<Record<RouteCapability, string>> = {
  server:
    "this target ships no server, so the route is never rendered - the URL 404s in production while working in dev. Add `export const prerender = true` (or `getStaticPaths` for a dynamic route), or build for a target that runs a server.",
  revalidation:
    "this target cannot revalidate a cached page, so `revalidate` has no effect and the route renders on every request.",
}

/**
 * Build the route manifest for a discovered app, optionally resolved against a deploy target.
 *
 * `prerendered` maps a route id to the concrete paths the build actually emitted for it - pass what
 * `prerenderRoutes` produced. Without it, dynamic routes are reported by their declaration alone, which
 * is the right answer before a build has run and the wrong one after.
 */
export async function buildRouteManifest(
  manifest: Manifest,
  options: {
    readonly target?: string
    readonly prerendered?: Readonly<Record<string, readonly string[]>>
  } = {},
): Promise<RouteManifest> {
  const entries: RouteManifestEntry[] = []
  for (const route of manifest.routes) {
    // Loading the module is what makes this authoritative rather than a guess from the filename: the
    // render mode lives in the module's exports and nowhere else.
    const module = (await route.load()) as RouteModule
    entries.push(deriveRouteEntry(route.id, route.pattern, module, options.prerendered?.[route.id]))
  }
  entries.sort((a, b) => a.pattern.localeCompare(b.pattern))

  const conflicts: RouteManifestConflict[] = []
  const capabilities =
    options.target === undefined ? undefined : TARGET_CAPABILITIES[options.target]
  if (capabilities !== undefined) {
    for (const entry of entries) {
      for (const capability of entry.requires) {
        if (capabilities.includes(capability)) continue
        conflicts.push({
          id: entry.id,
          pattern: entry.pattern,
          capability,
          consequence: CONSEQUENCE[capability],
        })
      }
    }
  }

  const totals: Record<RenderMode, number> = { static: 0, isr: 0, ssr: 0 }
  for (const entry of entries) totals[entry.mode] += 1

  const result: {
    target?: string
    routes: RouteManifestEntry[]
    conflicts: RouteManifestConflict[]
    totals: Record<RenderMode, number>
  } = { routes: entries, conflicts, totals }
  if (options.target !== undefined) result.target = options.target
  return result as RouteManifest
}

/** Render the manifest as a readable report - the `nifra routes --modes` output. */
export function renderRouteManifest(manifest: RouteManifest): string {
  const lines: string[] = []
  lines.push(
    manifest.target === undefined
      ? "nifra route manifest"
      : `nifra route manifest — target: ${manifest.target}`,
  )
  lines.push("")
  if (manifest.routes.length === 0) {
    lines.push("no routes found.")
    return lines.join("\n")
  }

  const width = Math.max(10, ...manifest.routes.map((r) => r.pattern.length)) + 2
  lines.push(`${"route".padEnd(width)}${"mode".padEnd(9)}${"hydrate".padEnd(9)}cache`)
  lines.push("-".repeat(width + 18 + 24))
  for (const route of manifest.routes) {
    const cache =
      route.mode === "isr"
        ? `revalidate ${route.revalidate}s`
        : route.mode === "static"
          ? `prerendered${route.prerenderedPaths ? ` (${route.prerenderedPaths.length})` : ""}`
          : "per request"
    lines.push(
      route.pattern.padEnd(width) +
        route.mode.padEnd(9) +
        (route.hydrate ? "yes" : "no").padEnd(9) +
        cache,
    )
  }
  lines.push("")
  lines.push(
    `${manifest.totals.static} static · ${manifest.totals.isr} isr · ${manifest.totals.ssr} ssr`,
  )

  if (manifest.conflicts.length > 0) {
    lines.push("")
    lines.push(`✗ ${manifest.conflicts.length} route(s) the target cannot honour:`)
    for (const conflict of manifest.conflicts) {
      lines.push(`  ✗ ${conflict.pattern} — ${conflict.consequence}`)
    }
  }
  return lines.join("\n")
}
