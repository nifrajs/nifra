/**
 * Per-module SSR invalidation for the **Bun pipeline's** dev server.
 *
 * Bun's runtime caches every module it has evaluated, and nothing invalidates that cache on a file
 * change. The dev server's answer used to stop at the route module: `discoverRoutes({ importQuery })`
 * appends a changing query to each route's own dynamic import, so the route re-evaluates. Its imports
 * do not - a component, a helper, a `*.server` module all keep resolving to the same cached specifier,
 * so SSR kept rendering the code that was on disk when the server started while the client, which Bun
 * rebuilds properly, rendered the edit. Every framework on this pipeline had it; the Vite pipeline does
 * not, because Vite owns its own SSR module graph.
 *
 * The fix is that module graph, in the small: watch what the server actually imported, notice which
 * files changed, and give exactly those - and everything that imports them - a fresh cache key.
 *
 * ## Why a version per module, and why version 0 means no query
 *
 * A cache key is a `?v=<n>` query on the resolved absolute path. Bun treats a distinct query as a
 * distinct registry entry and re-reads the file from disk (nifra's own Bun plugins already tolerate the
 * suffix - see the `(\?|$)` in their filters), so a bump is a reload of that module and nothing else.
 *
 * That "nothing else" is the reason versions start at 0 and 0 rewrites nothing at all. A module that has
 * never been edited keeps its bare path, which is the same registry entry the CLI already loaded when it
 * read the app's config and backend - so a database client, a queue handle, any module-scope singleton
 * shared between the backend and a route stays ONE instance. Versioning everything up front would have
 * forked those on the first request. Editing such a module does fork it, deliberately: the routes get
 * the new code and the already-running backend keeps the old, which is the same deal every dev server
 * makes, and the same one a restart resolves.
 *
 * ## Why importers have to be bumped too
 *
 * Re-evaluating a module re-runs its imports through resolution, but a module that is NOT re-evaluated
 * never re-resolves anything. With `route -> Layout -> Button` and an edit to `Button`, the route
 * re-evaluates (its own query moved), asks for `Layout` under the key it always used, and gets the
 * cached `Layout` back - which never mentions `Button` again. So a change propagates UP: the edited file
 * and every transitive importer of it are bumped together, and the chain re-evaluates from the route
 * down.
 *
 * ## Why the key is written into the source, not returned from `onResolve`
 *
 * Rewriting a resolution is the obvious mechanism and it only covers half of the imports people write.
 * Bun's runtime consults resolver plugins for a specifier that carries a file extension
 * (`"./Counter.tsx"`) and not for one that does not (`"./Counter"`, `"./components"`) - the extensionless
 * form is resolved on an internal fast path that no plugin, in any namespace, is offered. Measured on
 * Bun 1.3.14; the bundler has no such gap. Since extensionless is how most of this ecosystem's code is
 * written, an `onResolve`-only fix would have silently covered a minority of real apps.
 *
 * So the version is applied one level earlier, in the importer's own source: on load, each app-owned
 * module has its relative specifiers rewritten to absolute paths carrying the current version of the
 * file they point at. `onResolve` stays as well, because it is the only hook that sees modules loaded by
 * a third-party plugin this one does not wrap.
 *
 * Old versions stay in Bun's registry - a bounded dev-only leak, one entry per edit, which is what the
 * route-level query already did.
 *
 * Bun-only + dev-only; never imported by the edge runtime or by a production build.
 */
import { statSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { BunPlugin } from "bun"

/**
 * Extensions worth a version. Source and data only: an asset (`.css`, `.svg`, an image) either has no
 * server-side meaning or, like CSS Modules, compiles to a pure function of its path, so re-reading it
 * would change nothing about the rendered HTML.
 */
const VERSIONED = /\.(?:mts|cts|mjs|cjs|tsx|jsx|ts|js|svelte|vue|mdx|md|json)$/

/** Source this module can load and rewrite itself, when no framework plugin claims the file first. */
const REWRITABLE = "mts|cts|mjs|cjs|tsx|jsx|ts|js"

/**
 * The `onLoad` filter, which has to do the whole job of selecting app source: a **runtime** `onLoad`
 * handler may not decline a file it was offered (Bun raises `onLoad() expects an object returned`), so
 * anything this matches is loaded here - and a dependency's `.js` loaded as ESM when the package meant
 * CJS would break the app. Hence the shape: under the app root, no `node_modules` segment at any depth,
 * no dot-directory (`.nifra-bun/`, `.git/`), and a source extension, with an optional cache-busting
 * query. It mirrors {@link SsrGraph}'s ownership test; keep the two in step.
 */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** All path spellings Bun has used for an absolute Windows module id. */
const pathForms = (path: string): string[] => {
  const native = plainPath(path)
  const portable = native.replaceAll("\\", "/")
  const forms = [native, portable]
  if (process.platform === "win32" && /^[A-Za-z]:\//.test(portable)) forms.push(`/${portable}`)
  return [...new Set(forms)]
}

const appSourceFilter = (root: string): RegExp => {
  const roots = pathForms(root).map(escapeRegExp).join("|")
  return new RegExp(
    `^(?:${roots})[\\\\/]` +
      `(?!(?:.*[\\\\/])?node_modules[\\\\/])` +
      `(?!\\.)(?!.*[\\\\/]\\.)[^?]*\\.(?:${REWRITABLE})(?:\\?|$)`,
  )
}

/**
 * `from "x"`, `import "x"`, `import("x")`, `require("x")` - every form that carries a static specifier,
 * including `export ... from`. What it matches is only a candidate: a hit counts as an import only if the
 * transpiler's own scan reported the same specifier, which is what keeps a lookalike string literal out.
 */
const SPECIFIER = /\b(from|import|require)((?:\s*\()?\s*)(["'])([^"'\n]+)\3/g

export interface SsrGraphOptions {
  /** The app root. Only files under it (and outside `node_modules`) are tracked. */
  readonly root: string
}

export interface SsrGraph {
  /**
   * The Bun **runtime** plugin that records the graph and re-keys imports. Register it before the first
   * route module is imported; a runtime plugin only affects modules loaded after it.
   */
  readonly plugin: BunPlugin
  /**
   * Re-stat every tracked module and bump the versions of the changed ones and their importers.
   * Returns `true` when anything moved, i.e. when the app has to be rebuilt.
   */
  sweep(): boolean
  /** Bumped by each {@link sweep} that found a change. Belongs in the key the built app is cached under. */
  generation(): number
  /** Release the process-wide hook {@link rewriteSsrImports} reads. */
  dispose(): void
}

/** `/abs/path.ts?v=2` and `file:///abs/path.ts` both name `/abs/path.ts`. */
function plainPath(path: string): string {
  const withoutQuery = path.split("?", 1)[0] ?? path
  let value = withoutQuery
  if (value.startsWith("file://")) {
    try {
      value = fileURLToPath(value)
    } catch {
      // Let the caller's filesystem/resolver operation report a malformed URL.
    }
  }
  if (process.platform !== "win32") return value
  if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1)
  return value.replaceAll("/", "\\")
}

const mtimeOf = (path: string): number =>
  statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Number.NaN

/** What Bun should compile a file this module loaded itself as - the file's own extension decides. */
const loaderFor = (path: string): "tsx" | "ts" | "jsx" | "js" =>
  path.endsWith(".tsx")
    ? "tsx"
    : path.endsWith(".jsx")
      ? "jsx"
      : /\.[cm]?ts$/.test(path)
        ? "ts"
        : "js"

/**
 * What to PARSE a module as when scanning it for imports. `ts` is the safe default even for plain JS and
 * for a plugin's compiled output (TS ⊃ JS), and the one thing it cannot also parse is JSX - which is why
 * the JSX extensions are called out. Nothing here is emitted; the scan only reads specifiers.
 */
const scanLoaderFor = (path: string): "tsx" | "ts" =>
  path.endsWith(".tsx") || path.endsWith(".jsx") ? "tsx" : "ts"

/**
 * The active graph, for the framework plugins that own a file extension this module cannot load itself
 * (`.vue`, `.svelte`, `.tsx` under Solid, `.mdx`). Only one dev server runs per process.
 */
let active: { rewrite(contents: string, path: string): string } | undefined

/**
 * Re-key the app-owned imports of a module a **server-side** plugin just compiled. A plugin that claims a
 * file extension is the only code that sees that file's source, so it is the only place its imports can
 * be versioned; without this call every component in that language stays on the code it had at startup.
 *
 * A no-op outside a Bun dev server, and on the client half of a plugin - the client is bundled, and a
 * bundle has no import cache to bust.
 */
export function rewriteSsrImports(contents: string, path: string, generate: "dom" | "ssr"): string {
  if (generate !== "ssr" || active === undefined) return contents
  return active.rewrite(contents, plainPath(path))
}

/** Track and version the app's own server-side module graph. See the module doc for the whole design. */
export function createSsrGraph(options: SsrGraphOptions): SsrGraph {
  const root = resolve(plainPath(options.root))
  /** Every tracked module, by absolute path: its current cache version and the mtime it was read at. */
  const nodes = new Map<string, { version: number; mtime: number }>()
  /** Reverse edges - who imports this file - which is the direction invalidation travels. */
  const importers = new Map<string, Set<string>>()
  let generation = 0

  /** Inside the app, outside `node_modules`, outside dot-directories, and a file worth re-reading. */
  const owned = (abs: string): boolean => {
    const candidate = resolve(plainPath(abs))
    const rel = relative(root, candidate)
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel === "") return false
    // Relative to the app, so a project that itself lives under a dotted directory is not excluded
    // wholesale - this is about the app's own generated trees (`.nifra/`, `.nifra-bun/`, `.git/`).
    const portable = rel.replaceAll("\\", "/")
    if (
      portable === "node_modules" ||
      portable.startsWith("node_modules/") ||
      portable.includes("/node_modules/") ||
      portable.startsWith(".") ||
      portable.includes("/.")
    )
      return false
    return VERSIONED.test(candidate)
  }

  const track = (abs: string, importer: string): void => {
    const file = resolve(plainPath(abs))
    const parent = resolve(plainPath(importer))
    if (!nodes.has(file)) nodes.set(file, { version: 0, mtime: mtimeOf(file) })
    const parents = importers.get(file)
    if (parents === undefined) importers.set(file, new Set([parent]))
    else parents.add(parent)
  }

  // `Bun.resolveSync` re-enters this plugin's own `onResolve`, which is an unbounded recursion rather
  // than a slow path. The flag is safe because the handler and `resolveSync` are both synchronous.
  let resolving = false

  const resolveFrom = (specifier: string, dir: string): string | undefined => {
    resolving = true
    try {
      return Bun.resolveSync(specifier, dir)
    } catch {
      // Unresolvable here is not this module's error to report - leave it to Bun, which raises the
      // diagnostic the app author can act on.
      return undefined
    } finally {
      resolving = false
    }
  }

  /**
   * Record `specifier` as an edge out of `importer` and return what it should be imported as, or
   * `undefined` to leave the specifier exactly as the author wrote it.
   */
  const keyFor = (specifier: string, importer: string): string | undefined => {
    const abs = resolveFrom(specifier, dirname(importer))
    if (abs === undefined) return undefined
    const file = resolve(plainPath(abs))
    if (!owned(file)) return undefined
    track(file, importer)
    const version = nodes.get(file)?.version ?? 0
    // Version 0 is the shared, unversioned instance - see the module doc.
    return version === 0 ? undefined : `${file.replaceAll("\\", "/")}?v=${version}`
  }

  const rewrite = (contents: string, importer: string): string => {
    const importerPath = resolve(plainPath(importer))
    if (!owned(importerPath)) return contents
    let scanned: readonly { readonly path: string }[]
    try {
      scanned = new Bun.Transpiler({ loader: scanLoaderFor(importerPath) }).scanImports(contents)
    } catch {
      // Source Bun cannot parse is source Bun is about to reject with a real error message. Hand it
      // through untouched rather than adding a second, worse one.
      return contents
    }
    const candidates = new Set(scanned.map((entry) => entry.path).filter((p) => p.startsWith(".")))
    if (candidates.size === 0) return contents
    const keys = new Map<string, string>()
    for (const specifier of candidates) {
      const key = keyFor(specifier, importerPath)
      if (key !== undefined) keys.set(specifier, key)
    }
    if (keys.size === 0) return contents
    // Same length in lines and columns up to the specifier itself, so a stack trace still points at the
    // line the author wrote.
    return contents.replace(SPECIFIER, (whole, keyword, gap, quote, specifier) =>
      keys.has(specifier) ? `${keyword}${gap}${quote}${keys.get(specifier)}${quote}` : whole,
    )
  }

  const plugin: BunPlugin = {
    name: "nifra-dev-ssr-graph",
    setup(build) {
      // Every app-owned module that no other plugin claims: read it, re-key its imports, hand it back.
      // Loading it here is what makes the extensionless specifiers reachable at all (module doc).
      build.onLoad({ filter: appSourceFilter(root) }, async (args) => {
        const path = plainPath(args.path)
        const contents = await Bun.file(path).text()
        return { contents: rewrite(contents, path), loader: loaderFor(path) }
      })
      // The resolver half covers what the loader half cannot see: a module compiled by a plugin that
      // does not call `rewriteSsrImports`. Extension-bearing specifiers only, which is all Bun offers.
      build.onResolve({ filter: /^[./]/ }, (args) => {
        if (resolving) return undefined
        // A specifier that already carries a query is either this module's own rewrite or a plugin's
        // virtual sub-request (`?vue-css` and friends) - both are already keyed.
        if (args.path.includes("?")) return undefined
        const importer = plainPath(args.importer)
        if (!owned(importer)) return undefined
        const key = keyFor(args.path, importer)
        return key === undefined ? undefined : { path: key }
      })
    },
  }

  const sweep = (): boolean => {
    const dirty = new Set<string>()
    for (const [abs, node] of nodes) {
      const mtime = mtimeOf(abs)
      // NaN (deleted, or unreadable mid-save) never equals the recorded value, so it counts as changed
      // and the next successful stat settles it.
      if (mtime === node.mtime) continue
      node.mtime = mtime
      dirty.add(abs)
    }
    if (dirty.size === 0) return false
    // Breadth-first up the reverse edges: an importer of a changed module is itself stale, because it
    // holds the old binding and would not re-resolve on its own.
    const queue = [...dirty]
    for (let i = 0; i < queue.length; i++) {
      const child = queue[i]
      if (child === undefined) continue
      for (const parent of importers.get(child) ?? []) {
        if (dirty.has(parent)) continue
        dirty.add(parent)
        queue.push(parent)
      }
    }
    for (const abs of dirty) {
      const node = nodes.get(abs)
      if (node !== undefined) node.version += 1
    }
    generation += 1
    return true
  }

  const hook = { rewrite }
  active = hook
  return {
    plugin,
    sweep,
    generation: () => generation,
    dispose: () => {
      if (active === hook) active = undefined
    },
  }
}
