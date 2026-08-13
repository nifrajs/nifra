#!/usr/bin/env bun
/**
 * Compare the logical output of the Bun and Vite production pipelines on a small checked-in app.
 *
 * This is intentionally opt-in. The two pipelines may choose different hashed filenames and chunk
 * internals; the check compares the contract a deploy consumes instead: route entries, logical asset
 * roles, per-route chunk cardinality, copied public files, and CSS Module class values.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { BuildManifest } from "../packages/web/src/build.ts"
import { buildClient } from "../packages/web/src/build.ts"
import { buildClientVite } from "../packages/web/src/build-vite.ts"
import { discoverRoutes } from "../packages/web/src/fs.ts"
import {
  compareManifestParity,
  normalizeBuildManifest,
  logicalStaticAssets as sharedLogicalStaticAssets,
} from "../packages/web/src/internal/parity.ts"
import { cssModulesBunPlugin, transformCssModule } from "../packages/web/src/plugins/css-modules.ts"
import { reproduciblePath } from "../packages/web/src/plugins/kit.ts"

export interface ParitySnapshot {
  readonly routeManifest: readonly string[]
  readonly routeChunks: Readonly<Record<string, number>>
  readonly staticAssets: readonly string[]
  readonly cssModuleClassMaps: Readonly<Record<string, string>>
}

export interface ParityDifference {
  readonly section: "route-manifest" | "route-chunks" | "static-assets" | "css-module-class-maps"
  readonly bun: unknown
  readonly vite: unknown
}

export { compareManifestParity, normalizeBuildManifest }

const sorted = (values: readonly string[]): string[] => [...values].sort()

const manifestAsset = (url: string): string => url.replace(/^.*\//, "")

/** Turn hashed filenames into logical roles, preserving route and stylesheet ownership. */
export function logicalStaticAssets(manifest: BuildManifest): string[] {
  return [...sharedLogicalStaticAssets(manifest)]
}

const readJavaScript = (outDir: string): string => {
  const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as BuildManifest
  return manifest.assets
    .filter((asset) => asset.endsWith(".js"))
    .map((asset) => readFileSync(join(outDir, manifestAsset(asset)), "utf8"))
    .join("\n")
}

/** Record whether each expected CSS Module value reached the emitted route JavaScript. */
export function emittedCssModuleClassMap(
  outDir: string,
  expected: Readonly<Record<string, string>>,
): Record<string, string> {
  const javascript = readJavaScript(outDir)
  return Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [
      key,
      javascript.includes(JSON.stringify(value)) ? value : "<missing>",
    ]),
  )
}

export function compareParity(bun: ParitySnapshot, vite: ParitySnapshot): ParityDifference[] {
  const bunManifest = {
    entry: "assets/entry.js",
    assets: [
      "assets/entry.js",
      ...bun.staticAssets
        .filter((asset) => asset.startsWith("js:"))
        .map((asset) => `assets/${asset.slice(3)}.js`),
    ],
    routes: Object.fromEntries(
      Object.entries(bun.routeChunks).map(([route, count]) => [
        route,
        Array.from({ length: count }, (_, index) => `assets/route:${route}:${index}.js`),
      ]),
    ),
    publicFiles: bun.staticAssets
      .filter((asset) => asset.startsWith("public:"))
      .map((asset) => asset.slice("public:".length)),
    css: Object.keys(bun.cssModuleClassMaps).length > 0 ? ["assets/styles.css"] : [],
  }
  const viteManifest = {
    ...bunManifest,
    assets: [
      "assets/entry.js",
      ...vite.staticAssets
        .filter((asset) => asset.startsWith("js:"))
        .map((asset) => `assets/${asset.slice(3)}.js`),
    ],
    routes: Object.fromEntries(
      Object.entries(vite.routeChunks).map(([route, count]) => [
        route,
        Array.from({ length: count }, (_, index) => `assets/route:${route}:${index}.js`),
      ]),
    ),
    publicFiles: vite.staticAssets
      .filter((asset) => asset.startsWith("public:"))
      .map((asset) => asset.slice("public:".length)),
    css: Object.keys(vite.cssModuleClassMaps).length > 0 ? ["assets/styles.css"] : [],
  }
  const shared = compareManifestParity(
    normalizeBuildManifest(bunManifest),
    normalizeBuildManifest(viteManifest),
  )
  const differences: ParityDifference[] = []
  if (shared.some((difference) => difference.section === "module-graph")) {
    differences.push({
      section: "route-manifest",
      bun: bun.routeManifest,
      vite: vite.routeManifest,
    })
  }
  if (shared.some((difference) => difference.section === "module-graph")) {
    differences.push({ section: "route-chunks", bun: bun.routeChunks, vite: vite.routeChunks })
  }
  if (
    shared.some(
      (difference) =>
        difference.section === "module-graph" || difference.section === "public-files",
    )
  ) {
    differences.push({ section: "static-assets", bun: bun.staticAssets, vite: vite.staticAssets })
  }
  if (
    shared.some((difference) => difference.section === "css") ||
    JSON.stringify(bun.cssModuleClassMaps) !== JSON.stringify(vite.cssModuleClassMaps)
  ) {
    differences.push({
      section: "css-module-class-maps",
      bun: bun.cssModuleClassMaps,
      vite: vite.cssModuleClassMaps,
    })
  }
  return differences
}

const snapshot = (
  manifest: BuildManifest,
  outDir: string,
  cssMap: Readonly<Record<string, string>>,
): ParitySnapshot => ({
  routeManifest: sorted(Object.keys(manifest.routes)),
  routeChunks: Object.fromEntries(
    Object.entries(manifest.routes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([route, chunks]) => [route, chunks.length]),
  ),
  staticAssets: [
    ...logicalStaticAssets(manifest),
    ...(manifest.routes._404 === undefined ? [] : ["js:route:_404:0"]),
  ],
  cssModuleClassMaps: emittedCssModuleClassMap(outDir, cssMap),
})

export function formatParityReport(differences: readonly ParityDifference[]): string {
  const lines = [`Pipeline parity: ${differences.length === 0 ? "PASS" : "FAIL"}`]
  for (const section of [
    "route-manifest",
    "route-chunks",
    "static-assets",
    "css-module-class-maps",
  ] as const) {
    const difference = differences.find((item) => item.section === section)
    lines.push(`  ${section}: ${difference === undefined ? "PASS" : "FAIL"}`)
    if (difference !== undefined) {
      lines.push(`    Bun:  ${JSON.stringify(difference.bun)}`)
      lines.push(`    Vite: ${JSON.stringify(difference.vite)}`)
    }
  }
  return lines.join("\n")
}

async function main(): Promise<void> {
  const fixture = resolve(join(import.meta.dir, "fixtures/pipeline-parity"))
  const root = mkdtempSync(join(tmpdir(), "nifra-pipeline-parity-"))
  const bunOut = join(root, "bun")
  const viteOut = join(root, "vite")
  const routesDir = join(fixture, "routes")
  const clientModule = join(fixture, "client-stub.ts")
  const publicDir = join(fixture, "public")
  try {
    const [bun, vite] = await Promise.all([
      buildClient({
        routesDir,
        outDir: bunOut,
        clientModule,
        minify: false,
        publicDir,
        plugins: [cssModulesBunPlugin("dom")],
      }),
      buildClientVite({
        routesDir,
        outDir: viteOut,
        clientModule,
        root: fixture,
        minify: false,
        publicDir,
      }),
    ])
    const cssSource = readFileSync(join(fixture, "styles.module.css"), "utf8")
    const allCssMap = transformCssModule(
      cssSource,
      reproduciblePath(join(fixture, "styles.module.css")),
    ).exports
    // CSS Modules also exposes keyframe names in the Bun transform. The parity contract here is the
    // class-name map, so keep the fixture's keyframe in the stylesheet but compare only class exports.
    const cssMap = Object.fromEntries(
      ["box", "title"].flatMap((key) => (allCssMap[key] ? [[key, allCssMap[key]]] : [])),
    )
    // Discovering the fixture here is an explicit guard that the route source itself is still the app
    // both builds claim to contain. The build-manifest comparison below catches one pipeline dropping it.
    const sourceRoutes = sorted(discoverRoutes(routesDir).routes.map((route) => route.id))
    const bunSnapshot = snapshot(bun, bunOut, cssMap)
    const viteSnapshot = snapshot(vite, viteOut, cssMap)
    if (JSON.stringify(sourceRoutes) !== JSON.stringify(bunSnapshot.routeManifest)) {
      throw new Error(
        `Bun route manifest drifted from the fixture: ${JSON.stringify(bunSnapshot.routeManifest)}`,
      )
    }
    if (JSON.stringify(sourceRoutes) !== JSON.stringify(viteSnapshot.routeManifest)) {
      throw new Error(
        `Vite route manifest drifted from the fixture: ${JSON.stringify(viteSnapshot.routeManifest)}`,
      )
    }
    const differences = compareParity(bunSnapshot, viteSnapshot)
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ bun: bunSnapshot, vite: viteSnapshot, differences }, null, 2))
    } else {
      console.log(formatParityReport(differences))
    }
    if (differences.length > 0) process.exitCode = 1
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
