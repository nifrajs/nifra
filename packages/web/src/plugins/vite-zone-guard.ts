/**
 * The zone guard for Vite's dev server. A dev server serves source by URL, so the guard has to hold
 * before any byte is sent, whatever the URL form:
 *
 * - a middleware ahead of Vite's own answers 403 for any request that maps to a file the browser may
 *   not have: a direct path, `/@fs/`, `?raw`, `?url`, `?import`, a `.map`, a pre-bundled dependency;
 * - `resolveId` refuses a browser import of backend code at the importer, so the overlay names the line
 *   instead of the browser hitting a bare 403;
 * - `transform` refuses whatever reaches the client environment by another route.
 *
 * The SSR environment loads the same files legitimately and is never checked here.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { privateEnvDenial } from "../internal/private-env.ts"
import {
  browserDenial,
  type Classification,
  createZoneClassifier,
  SERVER_PACKAGES,
  specifierPackage,
} from "../zones.ts"

export interface ViteZoneGuardOptions {
  /** The app root: the directory holding `routes/`, `frontend/`, `backend/` and `shared/`. */
  readonly appRoot: string
  /** The routes directory (default `<appRoot>/routes`). */
  readonly routesDir?: string
  /** Generated client modules (the dev entry). */
  readonly generatedFiles?: readonly string[]
  /** The public-env prefix browser code may read (default `"PUBLIC_"`). */
  readonly publicEnvPrefix?: string
}

/** Zones whose code runs in a browser, so may read only public environment variables. */
const BROWSER_CODE = new Set<string>(["route-frontend", "frontend", "shared"])

type Next = (error?: unknown) => void
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void

interface PluginContext {
  readonly environment?: { readonly name?: string }
  error(error: Error | string): never
}

/** The slice of a Vite plugin this returns. Structural, so `vite` stays an optional peer. */
export interface ViteZoneGuardPlugin {
  readonly name: string
  readonly enforce: "pre"
  config(): { optimizeDeps: { exclude: string[] } }
  configResolved(config: { readonly root: string }): void
  configureServer(server: { readonly middlewares: { use(middleware: Middleware): void } }): void
  resolveId(
    this: PluginContext,
    source: string,
    importer: string | undefined,
    options?: { readonly ssr?: boolean; readonly scan?: boolean },
  ): null
  transform(
    this: PluginContext,
    code: string,
    id: string,
    options?: { readonly ssr?: boolean },
  ): null
  /**
   * Why the module a request URL names failed to serve, when the guard refused one of its imports.
   * Vite in middleware mode reports a transform error to the overlay and then passes the request on
   * instead of answering it; the dev server answers with this.
   */
  refusalFor(url: string): string | undefined
  /** The source file a request URL names, when it names one. */
  fileForUrl(url: string): string | undefined
}

const stripQuery = (id: string): string => id.replace(/[?#].*$/, "")
/** Query forms that hand a module's source, or a URL to it, to the browser untransformed. */
const RAW_QUERY = /(?:^|&)(?:raw|url|inline)(?:[&=]|$)/

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function viteZoneGuard(options: ViteZoneGuardOptions): ViteZoneGuardPlugin {
  const classifier = createZoneClassifier(options)
  let root = resolve(options.appRoot)
  const display = (file: string): string => {
    const rel = relative(classifier.appRoot, file)
    return rel.startsWith("..") || isAbsolute(rel) ? file : rel
  }
  const isClient = (context: PluginContext, ssr: boolean | undefined): boolean =>
    ssr !== true && (context.environment?.name ?? "client") === "client"

  /** What a pre-bundled dependency file was built from, per Vite's `_metadata.json`. */
  const depsSources = new Map<string, { mtime: number; sources: Map<string, string> }>()
  const depSource = (file: string): string | undefined => {
    const dir = dirname(file)
    const metadata = join(dir, "_metadata.json")
    let mtime: number
    try {
      mtime = statSync(metadata).mtimeMs
    } catch {
      return undefined
    }
    let cached = depsSources.get(dir)
    if (cached === undefined || cached.mtime !== mtime) {
      const sources = new Map<string, string>()
      try {
        const parsed = JSON.parse(readFileSync(metadata, "utf8")) as {
          optimized?: Record<string, { src?: string; file?: string }>
        }
        for (const dep of Object.values(parsed.optimized ?? {})) {
          if (dep.src !== undefined && dep.file !== undefined) {
            sources.set(resolve(dir, dep.file), resolve(dir, dep.src))
          }
        }
      } catch {
        // An unreadable metadata file maps nothing; the request then classifies as the cache file.
      }
      cached = { mtime, sources }
      depsSources.set(dir, cached)
    }
    return cached.sources.get(file)
  }

  /** The file a request URL serves, or `undefined` when it names none (an app route, a Vite internal). */
  const fileForUrl = (url: string): string | undefined => {
    let path: string
    try {
      path = decodeURIComponent(stripQuery(url))
    } catch {
      return undefined
    }
    let file: string
    if (path.startsWith("/@fs/")) file = path.slice("/@fs".length).replace(/^\/([a-zA-Z]:)/, "$1")
    else if (path.startsWith("/@id/")) {
      const id = path.slice("/@id/".length)
      if (!isAbsolute(id)) return undefined
      file = id
    } else if (path.startsWith("/@")) return undefined
    else file = join(root, path)
    for (const candidate of [file, file.replace(/\.map$/, "")]) {
      if (isFile(candidate)) return candidate
    }
    return undefined
  }

  const middleware: Middleware = (req, res, next) => {
    const url = req.url ?? "/"
    const file = fileForUrl(url)
    if (file === undefined) return next()
    const source = file.includes("/node_modules/.vite/") ? (depSource(file) ?? file) : file
    const classification = classifier.classify(source)
    let reason = browserDenial(classification)
    const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : ""
    if (reason === undefined && classification.zone === "fn" && RAW_QUERY.test(query)) {
      reason = "a server-function module reaches the browser only as its generated stub"
    }
    if (reason === undefined) return next()
    res.statusCode = 403
    res.setHeader("content-type", "text/plain; charset=utf-8")
    res.setHeader("cache-control", "no-store")
    res.end(`[nifra] ${display(source)} may not reach the browser: ${reason}\n`)
  }

  const refusals = new Map<string, string>()
  const refuse = (
    context: PluginContext,
    file: string,
    reason: string,
    importer?: string,
  ): never => {
    const message = `[nifra/web] ${display(file)} may not reach the browser${importer === undefined ? "" : ` (imported by ${display(importer)})`}: ${reason}`
    refusals.set(importer ?? file, message)
    return context.error(new Error(message))
  }

  /** A bare specifier's package, classified through its manifest so a workspace link is first-party. */
  const packageClassification = (name: string, importer: string): Classification => {
    let dir = dirname(importer)
    for (;;) {
      const manifest = join(dir, "node_modules", name, "package.json")
      if (existsSync(manifest)) return classifier.classify(manifest)
      const parent = dirname(dir)
      if (parent === dir) return { zone: "library", packageName: name }
      dir = parent
    }
  }

  return {
    name: "nifra:zone-guard",
    enforce: "pre",
    refusalFor(url) {
      const file = fileForUrl(url)
      return file === undefined ? undefined : refusals.get(file)
    },
    fileForUrl,
    // A pre-bundled copy would serve a server package under `.vite/deps/` instead of its own path.
    config: () => ({ optimizeDeps: { exclude: [...SERVER_PACKAGES] } }),
    configResolved(config) {
      root = config.root
    },
    configureServer(server) {
      // Registered directly (not in a returned post hook), so it runs ahead of Vite's own middlewares.
      server.middlewares.use(middleware)
    },
    resolveId(source, importer, resolveOptions) {
      if (importer === undefined || resolveOptions?.scan === true) return null
      if (!isClient(this, resolveOptions?.ssr)) return null
      const importerFile = stripQuery(importer)
      if (!isAbsolute(importerFile)) return null
      const name = specifierPackage(source)
      if (name !== undefined) {
        const reason = browserDenial(packageClassification(name, importerFile), source)
        if (reason !== undefined) refuse(this, source, reason, importerFile)
        return null
      }
      if (source.startsWith(".")) {
        const target = resolve(dirname(importerFile), stripQuery(source))
        if (isFile(target)) {
          const reason = browserDenial(classifier.classify(target))
          if (reason !== undefined) refuse(this, target, reason, importerFile)
        }
      }
      return null
    },
    transform(code, id, transformOptions) {
      if (!isClient(this, transformOptions?.ssr)) return null
      const file = stripQuery(id)
      if (!isAbsolute(file) || !isFile(file)) return null
      // A fresh transform re-resolves every import, so an earlier refusal is stale until it recurs.
      refusals.delete(file)
      const classification = classifier.classify(file)
      // A `pre` transform sees the file as written, so the env check reads the source the author wrote.
      const reason =
        browserDenial(classification) ??
        (BROWSER_CODE.has(classification.zone) && id === file
          ? privateEnvDenial(file, code, options.publicEnvPrefix ?? "PUBLIC_")
          : undefined)
      if (reason !== undefined) refuse(this, file, reason)
      return null
    },
  }
}
