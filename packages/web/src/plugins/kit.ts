/**
 * `@nifrajs/web/plugins` shared kit - the small infrastructure every CSS-bearing asset plugin reuses, so
 * P1 (CSS Modules), P2 (SCSS), and any future P4 (LESS/Stylus/PostCSS) don't each re-implement the
 * CSS→client-bundle wiring, the deterministic hash, or the optional-peer guard. Internal to
 * `@nifrajs/web` (imported by the sibling plugin modules); not a public subpath.
 */
import { existsSync } from "node:fs"
import { dirname, relative } from "node:path"
import type { BunPlugin } from "bun"

/** The argument Bun passes to a plugin's `setup` - Bun doesn't export the type, so derive it. */
export type PluginBuilder = Parameters<BunPlugin["setup"]>[0]

/**
 * Re-keys the app-owned imports of a module the SERVER half of a plugin just compiled, so an edit below
 * a route reaches SSR instead of being served from Bun's import cache. A plugin that claims a file
 * extension is the only code that ever sees that file's source, so it is the only place its imports can
 * be versioned - every `generate: "ssr"` loader should return its output through this.
 *
 * A no-op on the client half and outside a dev server. See `../dev-ssr-graph.ts` for the whole design.
 */
export { rewriteSsrImports } from "../dev-ssr-graph.ts"

const packageRootCache = new Map<string, string>()

/** The nearest ancestor directory of `startDir` that holds a `package.json` (the file's package root),
 * cached. Falls back to `startDir` if none is found, so it never throws. */
function packageRootOf(startDir: string): string {
  const cached = packageRootCache.get(startDir)
  if (cached !== undefined) return cached
  let dir = startDir
  for (;;) {
    if (existsSync(`${dir}/package.json`)) break
    const parent = dirname(dir)
    if (parent === dir) {
      dir = startDir // reached the filesystem root with no package.json - anchor on the file's own dir
      break
    }
    dir = parent
  }
  packageRootCache.set(startDir, dir)
  return dir
}

/**
 * A **package-root-relative**, forward-slashed form of an absolute path - the input to {@link hash8} for
 * any build-stable identifier (e.g. CSS-module scoped names). Anchoring on the file's nearest
 * `package.json` (not the absolute path, not `process.cwd()`) makes the result independent of BOTH the
 * machine's directory layout AND the working directory: the dom build and the ssr runtime - even on
 * different machines or from different cwds - derive the SAME relative path for a given file, so their
 * scoped class maps always agree. (Hashing the absolute path would differ across CI/host; a
 * cwd-relative path would silently desync if the SSR server started from a non-project-root cwd.)
 */
export function reproduciblePath(absolutePath: string): string {
  const root = packageRootOf(dirname(absolutePath))
  return relative(root, absolutePath).replaceAll("\\", "/")
}

/**
 * Deterministic 8-hex hash (djb2/xor). Stable across builds - no `Date.now`/`Math.random` - so build
 * output is reproducible. The single hash implementation behind CSS-module scoped names (and a drop-in
 * for any SFC scope id).
 */
export function hash8(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) h = (Math.imul(h, 33) ^ input.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, "0")
}

/**
 * Env flag a nifra dev server sets for its own lifetime, so a framework compiler plugin can tell a dev
 * compile from a `nifra build` one. Exported for the dev server that sets it; plugins ask
 * {@link devServerCompile} instead of reading it.
 */
export const DEV_HMR_ENV = "NIFRA_DEV_HMR"

/**
 * True while a nifra dev server is running, i.e. the compile may emit HMR wiring (and, where the
 * framework couples the two, dev-mode runtime output).
 *
 * The phase cannot be a plugin constructor argument: an app builds its `clientPlugins` once in
 * `nifra.config.ts` and the same plugin objects serve both `nifra dev` and `nifra build`. Guarding the
 * emitted code with `if (import.meta.hot)` is not sufficient either - `Bun.build` keeps the branch, so
 * the HMR calls were measured shipping in production client chunks. The dev server announces itself in
 * the environment instead, and `nifra build` never sets it. Read per compile (not captured at
 * registration) so the flag is honoured however late the server sets it.
 */
export function devServerCompile(): boolean {
  return process.env[DEV_HMR_ENV] === "1"
}

/**
 * The app root and the routes directory of the running dev server, for plugins that need to tell one of
 * the app's own components from a dependency or a route module. Set alongside {@link DEV_HMR_ENV}; read
 * through {@link devHotComponent}.
 */
export const DEV_ROOT_ENV = "NIFRA_DEV_ROOT"
export const DEV_ROUTES_ENV = "NIFRA_DEV_ROUTES"

const under = (path: string, dir: string | undefined): boolean =>
  dir !== undefined &&
  dir !== "" &&
  (path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`))

/**
 * Whether a dev compile of `path` may wrap the module in component-level hot-patching - i.e. whether it
 * is one of the app's OWN components rather than a dependency or a route module.
 *
 * The exclusions are not caution, they are two things such a wrapper cannot survive:
 *
 *   - a **dependency**, whose components are the framework's own composition machinery. An adapter folds
 *     a layout chain through them, so they are entered from a snippet or as a dynamic component - and a
 *     wrapper there sits between the SSR markup and the component that is supposed to claim it.
 *   - a **route module**, for the same reason one level down: a route or layout IS a chain member, so it
 *     is always the dynamic child. It is also the wrong boundary to patch - a route module carries the
 *     loader and meta the server ran, and re-running those is a navigation, not a patch. Editing one
 *     finds no accepting module and reloads the page, which is the correct outcome.
 *
 * Both cost nothing in practice: the components an edit loop actually touches are the views, and a view
 * that wants to hot-patch lives outside the routes directory. Where the split is unknown (no dev server,
 * or a root that was never announced), the answer is `false` - a full reload is always correct, a
 * mispatched tree is not.
 */
export function devHotComponent(path: string): boolean {
  const root = process.env[DEV_ROOT_ENV]
  if (!under(path, root)) return false
  if (path.includes("/node_modules/")) return false
  return !under(path, process.env[DEV_ROUTES_ENV])
}

/**
 * Records compiled CSS and wires it into the client bundle through a virtual `?<namespace>` module -
 * the idiom the Vue plugin established (`?vue-css`). Register one per plugin `setup`; call `emit` per
 * file to stash its CSS and get back the `import` line to append to the JS module.
 */
export interface StylesheetEmitter {
  /** Store `css` for `path`, returning the `import "<path>?<namespace>"` line for the JS module. */
  emit(path: string, css: string): string
}

/**
 * Wire the virtual-CSS-module handlers onto `build` for `namespace`, returning an {@link StylesheetEmitter}.
 * The `namespace` must be a plain identifier (letters/`-`); it's used verbatim as the import suffix and
 * the Bun namespace. Only the `"dom"` build should emit CSS - the `"ssr"` build ships no stylesheet.
 */
export function createStylesheetEmitter(
  build: PluginBuilder,
  namespace: string,
): StylesheetEmitter {
  const suffix = `?${namespace}`
  const cssByPath = new Map<string, string>()
  // `\?${namespace}$`: namespaces are plain identifiers, so no regex metachars to escape.
  build.onResolve({ filter: new RegExp(`\\?${namespace}$`) }, (args) => ({
    path: args.path,
    namespace,
  }))
  build.onLoad({ filter: /.*/, namespace }, (args) => ({
    contents: cssByPath.get(args.path.slice(0, -suffix.length)) ?? "",
    loader: "css",
  }))
  return {
    emit(path, css) {
      cssByPath.set(path, css)
      return `import ${JSON.stringify(path + suffix)}\n`
    },
  }
}

/**
 * Load an optional peer compiler at build time, throwing a consistent, actionable install-hint error if
 * it's absent - the `@vue/compiler-sfc` peer pattern, centralized. Build-time only, so the dynamic
 * `import` (which keeps the peer out of the package's hard dependencies) is correct here.
 */
export async function requirePeer<T>(
  specifier: string,
  hint: { readonly feature: string; readonly install: string },
): Promise<T> {
  try {
    return (await import(specifier)) as T
  } catch (err) {
    // Only a genuine resolution failure means "not installed" - surface anything else (a corrupt
    // install, a native-binding error, a throw at module top-level) as the real error rather than
    // masking it behind a misleading "please install it" hint.
    if ((err as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        `[nifra/web] ${hint.feature} requires the optional peer "${specifier}". Install it: ${hint.install}`,
      )
    }
    throw new Error(
      `[nifra/web] ${hint.feature}: the optional peer "${specifier}" is installed but failed to load.`,
      { cause: err },
    )
  }
}
