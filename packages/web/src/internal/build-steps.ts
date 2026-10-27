/**
 * The build steps the Bun and Vite pipelines share: writing the generated bootstrap, listing the extra
 * entrypoints, completing and writing `manifest.json`, and writing the server route manifest.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve as resolvePath } from "node:path"
import type { BuildManifest } from "../build-plan.ts"
import type { CssLoadingMode } from "../css-contract.ts"
import { discoverRoutes } from "../fs.ts"
import type { Manifest } from "../manifest.ts"
import {
  type GenerateClientEntryOptions,
  type GenerateServerManifestOptions,
  generateClientEntry,
  generateServerManifest,
} from "./codegen.ts"
import { assertDevelopmentProductionParity, collectDevelopmentParityInput } from "./parity.ts"

/**
 * Write the generated client bootstrap into a fresh `prefix` directory beside `routesDir`, not inside
 * the output directory: module resolution starts at the importing file, so an absolute `--out /tmp/deploy`
 * must still resolve the app's dependencies, and a unique directory never clobbers a user file or a
 * parallel build. A client bundle has no Node `process`, so the entry provides a minimal one for a stray
 * bare reference (`process.env.*` reads are replaced at compile time by `define`).
 */
export function writeClientEntry(
  routesDir: string,
  prefix: string,
  manifest: Manifest,
  options: GenerateClientEntryOptions,
): { readonly dir: string; readonly file: string } {
  const dir = mkdtempSync(resolvePath(dirname(routesDir), prefix))
  const file = `${dir}/_nifra-entry.ts`
  writeFileSync(
    file,
    `globalThis.process ??= { env: {} };\n${generateClientEntry(manifest, options)}`,
  )
  return { dir, file }
}

/** Every unique route, layout, `_404` and `_loading` file, sorted: each an extra entrypoint, so the
 * bundler emits a named chunk per file that the bootstrap's lazy `import()` dedupes to. */
export function clientEntryFiles(manifest: Manifest): string[] {
  return [
    ...new Set([
      ...manifest.routes.map((r) => r.file),
      ...Object.values(manifest.layouts).map((l) => l.file),
      ...(manifest.notFound ? [manifest.notFound.file] : []),
      // A nested `_404` is an entry only for its stylesheet: it renders on the server, unhydrated.
      ...Object.values(manifest.notFounds ?? {}).map((page) => page.file),
      // A `_loading` page is an entry for its stylesheet too: the bootstrap imports it lazily.
      ...Object.values(manifest.loadings ?? {}).map((page) => page.file),
    ]),
  ].sort()
}

/**
 * Each page's stylesheets by id (`_404` for the root not-found page), `stylesFor` mapping the files a
 * page renders, layouts first, to their CSS. A `_loading` page can show on a navigation from any page,
 * and a document links only its own route's stylesheets, so every page that can start a navigation
 * carries the loading pages' too.
 */
export function pageStyles(
  manifest: Manifest,
  stylesFor: (files: readonly string[]) => readonly string[],
): Record<string, readonly string[]> {
  const styles: Record<string, readonly string[]> = {}
  const layoutFiles = (layoutIds: readonly string[]): string[] =>
    layoutIds.map((id) => manifest.layouts[id]?.file ?? "")
  const loadingFiles = Object.values(manifest.loadings ?? {}).map((page) => page.file)
  for (const route of manifest.routes)
    styles[route.id] = stylesFor([...layoutFiles(route.layoutIds), route.file, ...loadingFiles])
  if (manifest.notFound) styles._404 = stylesFor([manifest.notFound.file, ...loadingFiles])
  for (const [id, page] of Object.entries(manifest.notFounds ?? {}))
    styles[id] = stylesFor([...layoutFiles(page.layoutIds), page.file])
  return styles
}

/**
 * Writes the routes' server manifest next to `serverEntry`, as `manifestFile` (`server-manifest.ts` by
 * default), importing each route through `resolve`: by default relative from there to `routesDir`.
 * Returns the manifest's path.
 */
export function writeServerManifest(
  placement: {
    readonly routesDir: string
    readonly serverEntry: string
    readonly manifestFile?: string | undefined
    readonly resolve?: ((file: string) => string) | undefined
  },
  {
    cssLoading,
    ...options
  }: Omit<GenerateServerManifestOptions, "resolve" | "cssLoading"> & {
    readonly cssLoading?: CssLoadingMode | undefined
  },
): string {
  const { routesDir } = placement
  const entryDir = dirname(placement.serverEntry)
  const rel = relative(entryDir, routesDir).replaceAll("\\", "/")
  const file = `${entryDir}/${placement.manifestFile ?? "server-manifest.ts"}`
  const resolve = placement.resolve ?? ((route: string) => `./${rel}/${route}`)
  writeFileSync(
    file,
    generateServerManifest(discoverRoutes(routesDir), {
      resolve,
      ...options,
      ...(cssLoading !== undefined ? { cssLoading } : {}),
    }),
  )
  return file
}

/** What a client build adds to its manifest only when there is some. */
export interface ClientManifestExtras {
  readonly publicFiles: readonly string[]
  readonly css: readonly string[]
  readonly routeStyles: NonNullable<BuildManifest["routeStyles"]>
  readonly copyChunks: NonNullable<BuildManifest["copyChunks"]>
}

/** Complete a client manifest with the extras it has, check it against development, and write
 * `manifest.json` into `outDir`. */
export function writeClientManifest(
  head: Pick<BuildManifest, "entry" | "assets" | "routes" | "cssCodeSplit" | "cssLoading">,
  extras: ClientManifestExtras,
  dirs: {
    readonly routesDir: string
    readonly publicDir: string | undefined
    readonly outDir: string
  },
): BuildManifest {
  const { publicFiles, css, routeStyles, copyChunks } = extras
  const manifest: BuildManifest = {
    ...head,
    ...(publicFiles.length > 0 ? { publicFiles } : {}),
    ...(css.length > 0 ? { css } : {}),
    ...(Object.keys(routeStyles).length > 0 ? { routeStyles } : {}),
    ...(Object.keys(copyChunks).length > 0 ? { copyChunks } : {}),
  }
  assertDevelopmentProductionParity(
    collectDevelopmentParityInput(dirs.routesDir, dirs.publicDir),
    manifest,
  )
  writeFileSync(`${dirs.outDir}/manifest.json`, JSON.stringify(manifest, null, 2))
  return manifest
}
