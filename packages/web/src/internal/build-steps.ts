/**
 * The build steps the Bun and Vite pipelines share: writing the generated bootstrap, listing the extra
 * entrypoints, and completing and writing `manifest.json`.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
import type { BuildManifest } from "../build-plan.ts"
import type { Manifest } from "../manifest.ts"
import { type GenerateClientEntryOptions, generateClientEntry } from "./codegen.ts"
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
