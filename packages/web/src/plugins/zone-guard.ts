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
import { privateEnvDenial } from "../internal/private-env.ts"
import {
  BACKEND_ONLY_MARKER,
  browserDenial,
  createZoneClassifier,
  type ZoneClassifier,
} from "../zones.ts"

/** Source files Bun loads through a loader that tolerates a declining `onLoad`. Every other file
 * (images, fonts, wasm, and a `.pem` or `.sql` imported `with { type: "text" }`) goes through
 * `onResolve`: a file-loader asset panics Bun 1.4 on a declining `onLoad`. */
const SOURCE_FILE =
  /\.(?:[cm]?[jt]sx?|svelte|vue|mdx|astro|css|scss|sass|less|json|jsonc|toml|ya?ml|txt|md)$/
/** A relative or absolute import whose last segment has an extension. */
const PATH_WITH_EXTENSION = /^(?:\.|\/|[A-Za-z]:[\\/]).*\.[^./\\?#]+(?:[?#].*)?$/

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
  /** The public-env prefix browser code may read (default `"PUBLIC_"`). Checked here only in throw
   * mode; a build checks the finished graph instead. */
  readonly publicEnvPrefix?: string
}

/** Zones whose code runs in a browser, so may read only public environment variables. */
const BROWSER_CODE = new Set<string>(["route-frontend", "frontend", "shared"])

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
      build.onLoad({ filter: SOURCE_FILE }, async (args) => {
        if (args.namespace !== "file") return undefined
        const classification = classifier.classify(args.path)
        let reason = browserDenial(classification)
        if (
          reason === undefined &&
          options.onDenied === undefined &&
          BROWSER_CODE.has(classification.zone)
        ) {
          const source = await Bun.file(args.path).text()
          reason = privateEnvDenial(args.path, source, options.publicEnvPrefix ?? "PUBLIC_")
        }
        return reason === undefined ? undefined : refuse(args.path, reason)
      })
      build.onResolve({ filter: PATH_WITH_EXTENSION }, (args) => {
        const path = args.path.replace(/[?#].*$/, "")
        // An entry point (a dev server's HTML page) is the build's own choice, not an import.
        if (SOURCE_FILE.test(path) || args.importer === "") return undefined
        const file = resolve(dirname(args.importer), path)
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
