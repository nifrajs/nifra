/**
 * Copy tables (`@nifrajs/i18n/copy`) in a production client build. Each table a module declares is
 * replaced by its chunk id, and its values move into one chunk per locale, so a page's JavaScript carries
 * the copy of the locale it renders in and none of the others. The server bundle keeps every table whole.
 *
 * The tables are found by `@nifrajs/i18n/extract` with the app's own TypeScript, both resolved from the
 * app root: `@nifrajs/web` depends on neither. An app with no `defineCopy` pays one source scan.
 */
import { createHash } from "node:crypto"
import { type Dirent, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
import type { BunPlugin } from "bun"
import type * as TS from "typescript"
import { addSourceTransform, normalizeFilePath } from "../plugins/kit.ts"
import { isTypeScriptCompiler } from "./typescript-api.ts"

const COPY_MODULE = "@nifrajs/i18n/copy"
const EXTRACT_MODULE = "@nifrajs/i18n/extract"
const SCRIPT = /\.[cm]?[jt]sx?$/
const REWRITABLE = /\.m?[jt]sx?(\?|$)/
const DEPENDENCY = /[\\/]node_modules[\\/]/
const MAX_DEPTH = 32

/** The part of `@nifrajs/i18n/extract` the build reads. */
interface TableSite {
  readonly id: string
  readonly values?: Readonly<Record<string, unknown>>
  readonly definition: { readonly file: string; readonly name: string }
}
interface Scanner {
  tables(file: string): readonly TableSite[]
  definition(ref: TableSite["definition"]): { readonly locales?: unknown } | undefined
  rewrite(file: string): string | undefined
}
interface SplitTable {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly locales: unknown
}
interface Extract {
  createCopyScanner(
    ts: typeof TS,
    host: {
      readonly root: string
      read(file: string): string | undefined
      resolve(specifier: string, from: string): string | undefined
    },
  ): Scanner
  copyChunks(tables: Iterable<SplitTable>): ReadonlyMap<string, unknown>
}

const isExtract = (value: unknown): value is Extract =>
  typeof value === "object" &&
  value !== null &&
  "createCopyScanner" in value &&
  typeof value.createCopyScanner === "function" &&
  "copyChunks" in value &&
  typeof value.copyChunks === "function"

/** A chunk file the build wrote. */
export interface CopyChunkFile {
  /** The file name, served under the build's public path. */
  readonly name: string
  readonly text: string
}

export interface CopySplit {
  /** The client build's plugin, registered after every other one. */
  readonly plugin: BunPlugin
  /** A module with its tables replaced by chunk ids, or `undefined` when it has none to split. */
  rewrite(file: string, source: string): string | undefined
  /** One chunk per locale for the tables this build split, and each one's URL by locale key. */
  chunks(publicPath: string): {
    readonly urls: Readonly<Record<string, string>>
    readonly files: readonly CopyChunkFile[]
  }
}

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** Whether a module under `dir` imports the copy module: the only way an app defines copy tables. */
function definesCopy(dir: string, skip: ReadonlySet<string>, depth = 0): boolean {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH && !skip.has(path) && definesCopy(path, skip, depth + 1)) return true
    } else if (entry.isFile() && SCRIPT.test(entry.name)) {
      if (readText(path)?.includes(COPY_MODULE) === true) return true
    }
  }
  return false
}

const loaderOf = (path: string): "js" | "jsx" | "ts" | "tsx" => {
  if (path.endsWith("x")) return path.endsWith(".tsx") ? "tsx" : "jsx"
  return /\.m?ts$/.test(path) ? "ts" : "js"
}

/**
 * The copy split for an app, or `undefined` when it defines no copy tables. An app that does, but whose
 * TypeScript has no compiler API, builds with its tables whole, with a warning.
 */
export async function loadCopySplit(
  root: string,
  options: { readonly skip?: readonly string[]; readonly warn?: (message: string) => void } = {},
): Promise<CopySplit | undefined> {
  const appRoot = resolvePath(root)
  const require = createRequire(join(appRoot, "package.json"))
  let extractPath: string
  try {
    extractPath = require.resolve(EXTRACT_MODULE)
  } catch {
    return undefined
  }
  if (!definesCopy(appRoot, new Set((options.skip ?? []).map((dir) => resolvePath(dir))))) {
    return undefined
  }
  const warn = options.warn ?? console.warn
  let ts: unknown
  try {
    ts = require("typescript")
  } catch {
    ts = undefined
  }
  if (!isTypeScriptCompiler(ts)) {
    warn(
      "[nifra/web] copy tables ship every locale in the client bundle: splitting them by locale reads the source with the TypeScript compiler API, and the app's TypeScript has none (TypeScript 7 ships none; install typescript@^6 as a dev dependency).",
    )
    return undefined
  }
  const extract: unknown = await import(pathToFileURL(extractPath).href)
  if (!isExtract(extract)) {
    warn(
      `[nifra/web] copy tables ship every locale in the client bundle: ${EXTRACT_MODULE} at ${extractPath} predates the client split; update @nifrajs/i18n.`,
    )
    return undefined
  }
  const scanner = extract.createCopyScanner(ts, {
    root: appRoot.replaceAll("\\", "/"),
    read: readText,
    resolve: (specifier, from) => {
      try {
        return createRequire(from).resolve(specifier)
      } catch {
        return undefined
      }
    },
  })

  const split = new Map<string, readonly SplitTable[]>()
  const rewrite = (file: string, source: string): string | undefined => {
    const path = normalizeFilePath(file)
    // The scanner reads the file off disk: text another transform changed first is left alone, since
    // its tables' positions are no longer the file's.
    if (!REWRITABLE.test(path) || DEPENDENCY.test(path) || readText(path) !== source) {
      return undefined
    }
    const out = scanner.rewrite(path)
    if (out === undefined) return undefined
    split.set(
      path,
      scanner.tables(path).flatMap((site) => {
        const locales =
          site.values === undefined ? undefined : scanner.definition(site.definition)?.locales
        return site.values === undefined || locales === undefined
          ? []
          : [{ id: site.id, values: site.values, locales }]
      }),
    )
    return out
  }

  return {
    plugin: {
      name: "nifra-copy-split",
      setup(build) {
        addSourceTransform(build, rewrite)
        build.onLoad({ filter: REWRITABLE }, async (args) => {
          if (args.namespace !== "file") return undefined
          const path = normalizeFilePath(args.path)
          const contents = rewrite(path, await Bun.file(path).text())
          return contents === undefined ? undefined : { contents, loader: loaderOf(path) }
        })
      },
    },
    rewrite,
    chunks(publicPath) {
      // Sorted, so a chunk's bytes, and so its name, do not depend on the order modules loaded in.
      const tables = [...split.values()].flat().sort((a, b) => (a.id < b.id ? -1 : 1))
      const urls: Record<string, string> = {}
      const files: CopyChunkFile[] = []
      if (tables.length === 0) return { urls, files }
      const chunks = [...extract.copyChunks(tables)].sort(([a], [b]) => (a < b ? -1 : 1))
      for (const [locale, chunk] of chunks) {
        // A JSON string parses faster than the same object as a literal.
        const text = `export default JSON.parse(${JSON.stringify(JSON.stringify(chunk))})\n`
        const hash = createHash("sha256").update(text).digest("hex").slice(0, 12)
        const name = `copy-${locale.replace(/[^A-Za-z0-9-]/g, "_")}-${hash}.js`
        urls[locale] = `${publicPath}${name}`
        files.push({ name, text })
      }
      return { urls, files }
    },
  }
}
