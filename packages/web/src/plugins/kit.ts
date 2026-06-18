/**
 * `@nifrajs/web/plugins` shared kit — the small infrastructure every CSS-bearing asset plugin reuses, so
 * P1 (CSS Modules), P2 (SCSS), and any future P4 (LESS/Stylus/PostCSS) don't each re-implement the
 * CSS→client-bundle wiring, the deterministic hash, or the optional-peer guard. Internal to
 * `@nifrajs/web` (imported by the sibling plugin modules); not a public subpath.
 */
import { existsSync } from "node:fs"
import { dirname, relative } from "node:path"
import type { BunPlugin } from "bun"

/** The argument Bun passes to a plugin's `setup` — Bun doesn't export the type, so derive it. */
export type PluginBuilder = Parameters<BunPlugin["setup"]>[0]

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
      dir = startDir // reached the filesystem root with no package.json — anchor on the file's own dir
      break
    }
    dir = parent
  }
  packageRootCache.set(startDir, dir)
  return dir
}

/**
 * A **package-root-relative**, forward-slashed form of an absolute path — the input to {@link hash8} for
 * any build-stable identifier (e.g. CSS-module scoped names). Anchoring on the file's nearest
 * `package.json` (not the absolute path, not `process.cwd()`) makes the result independent of BOTH the
 * machine's directory layout AND the working directory: the dom build and the ssr runtime — even on
 * different machines or from different cwds — derive the SAME relative path for a given file, so their
 * scoped class maps always agree. (Hashing the absolute path would differ across CI/host; a
 * cwd-relative path would silently desync if the SSR server started from a non-project-root cwd.)
 */
export function reproduciblePath(absolutePath: string): string {
  const root = packageRootOf(dirname(absolutePath))
  return relative(root, absolutePath).replaceAll("\\", "/")
}

/**
 * Deterministic 8-hex hash (djb2/xor). Stable across builds — no `Date.now`/`Math.random` — so build
 * output is reproducible. The single hash implementation behind CSS-module scoped names (and a drop-in
 * for any SFC scope id).
 */
export function hash8(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) h = (Math.imul(h, 33) ^ input.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, "0")
}

/**
 * Records compiled CSS and wires it into the client bundle through a virtual `?<namespace>` module —
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
 * the Bun namespace. Only the `"dom"` build should emit CSS — the `"ssr"` build ships no stylesheet.
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
 * it's absent — the `@vue/compiler-sfc` peer pattern, centralized. Build-time only, so the dynamic
 * `import` (which keeps the peer out of the package's hard dependencies) is correct here.
 */
export async function requirePeer<T>(
  specifier: string,
  hint: { readonly feature: string; readonly install: string },
): Promise<T> {
  try {
    return (await import(specifier)) as T
  } catch (err) {
    // Only a genuine resolution failure means "not installed" — surface anything else (a corrupt
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
