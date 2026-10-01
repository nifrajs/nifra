/**
 * The zone guard for Bun's bundler: every file the browser bundle loads is classified, and one that may
 * not reach a browser stops the build (or the dev request) before its code is bundled.
 *
 * The client build runs it in `record` mode and reports every refusal together with its import chain,
 * read from the finished graph; the dev server runs it in `throw` mode, where there is no finished graph
 * and the refusal must stop the response.
 */

import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { BunPlugin } from "bun"
import {
  BACKEND_ONLY_MARKER,
  browserDenial,
  createZoneClassifier,
  type ZoneClassifier,
} from "../zones.ts"

/** Source files Bun loads through a loader that tolerates a declining `onLoad`. File-loader assets
 * (images, fonts, wasm) panic Bun 1.4 on a declining `onLoad`, so those go through `onResolve`. */
const SOURCE_FILE =
  /\.(?:[cm]?[jt]sx?|svelte|vue|mdx|astro|css|scss|sass|less|json|jsonc|toml|ya?ml|txt|md)$/
const ASSET_FILE =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|svg|woff2?|ttf|otf|eot|wasm|mp3|mp4|webm|ogg|wav|pdf)$/i

export interface ZoneGuardOptions {
  /** The app root: the directory holding `routes/`, `frontend/`, `backend/` and `shared/`. */
  readonly appRoot: string
  /** The routes directory (default `<appRoot>/routes`). */
  readonly routesDir?: string
  /** The build's own generated entry modules. */
  readonly generatedFiles?: readonly string[]
  /** Collect refusals instead of throwing; the caller reports them with chains after the build. */
  readonly onDenied?: (file: string, reason: string) => void
  /** Share a classifier with post-build verification. */
  readonly classifier?: ZoneClassifier
}

export function zoneGuardPlugin(options: ZoneGuardOptions): BunPlugin {
  const classifier = options.classifier ?? createZoneClassifier(options)
  const display = (file: string): string => {
    const rel = relative(classifier.appRoot, file)
    return rel.startsWith("..") || isAbsolute(rel) ? file : rel
  }
  const refuse = (file: string, reason: string, importer?: string): undefined => {
    if (options.onDenied !== undefined) {
      options.onDenied(file, reason)
      return undefined
    }
    const via =
      importer === undefined || importer === "" ? "" : ` (imported by ${display(importer)})`
    throw new Error(`[nifra/web] ${display(file)} may not reach the browser${via}: ${reason}`)
  }
  return {
    name: "nifra-zone-guard",
    setup(build) {
      build.onLoad({ filter: SOURCE_FILE }, (args) => {
        if (args.namespace !== "file") return undefined
        const reason = browserDenial(classifier.classify(args.path))
        return reason === undefined ? undefined : refuse(args.path, reason)
      })
      build.onResolve({ filter: ASSET_FILE }, (args) => {
        if (!args.path.startsWith(".") && !isAbsolute(args.path)) return undefined
        const file = resolve(dirname(args.importer), args.path.replace(/[?#].*$/, ""))
        const reason = browserDenial(classifier.classify(file))
        return reason === undefined ? undefined : refuse(file, reason, args.importer)
      })
      // In record mode the finished graph reports these, with chains; only the dev server needs them here.
      if (options.onDenied !== undefined) return
      build.onResolve({ filter: /^(?:node|bun):/ }, (args) =>
        refuse(
          args.path,
          "Node and Bun built-ins run on the server only; use them in a route's backend half or under backend/",
          args.importer,
        ),
      )
      build.onResolve(
        { filter: new RegExp(`^${BACKEND_ONLY_MARKER.replaceAll("/", "\\/")}$`) },
        (args) =>
          refuse(args.importer, `it imports "${BACKEND_ONLY_MARKER}", which marks it backend-only`),
      )
    },
  }
}
