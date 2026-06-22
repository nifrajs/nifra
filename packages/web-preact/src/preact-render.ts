/**
 * Resolve `preact-render-to-string` (+ its `/stream` subpath) so the renderer shares ONE `preact`
 * module-global with the route components — the fix for the dual-Preact SSR crash (`undefined is not an
 * object (evaluating '…__H')` / silently-empty hook output).
 *
 * WHY this exists: `preact-render-to-string` imports `options` and `h` from `preact` and mutates the
 * shared `options` hooks; `preact/hooks` registers its render hook on the SAME `options` global. Under Bun
 * **runtime** SSR (`nifra dev`, `nifra start`, `nifra_render`, all in-process), a static
 * `import "preact-render-to-string"` in this adapter is resolved from THIS package's own (symlinked)
 * node_modules — which can be a DIFFERENT physical `preact` than the consumer app's components import. Two
 * `preact` copies → two `options` globals → the renderer walks one while `preact/hooks` wrote the other →
 * the vnode never gets its hook-state list → the crash. Resolving the renderer from the consumer **app
 * root** makes it pull the app's `preact` transitively, matching the components: one `options`, one core,
 * no crash. (Empirically verified against a two-copy install fixture — see test/dual-preact.test.ts.)
 *
 * Guarding precisely so the PRODUCTION/BUILT path is untouched: when `Bun.resolveSync` is unavailable
 * (Node / Deno / Cloudflare / Vercel / any bundled output), the build has already bundled a single
 * `preact` + renderer, so the static `import` is correct AND the only thing that works without a Bun
 * resolver. We fall back to it there. The app-root resolution runs ONLY under the Bun runtime.
 */

import type { VNode } from "preact"

/** The slice of `preact-render-to-string` this adapter uses. */
export interface PreactRenderToString {
  renderToString(node: VNode): string
}
/** The slice of `preact-render-to-string/stream`. */
export interface PreactRenderToStream {
  renderToReadableStream(node: VNode): ReadableStream<Uint8Array>
}

// Narrow only the one Bun method we need (it isn't in the ambient lib types) so no `any` is introduced.
// `resolveSync(specifier, from)` is the only lever that re-roots a BARE specifier — a runtime
// `Bun.plugin` onResolve does NOT fire for bare specifiers like `preact-render-to-string` (verified).
interface BunResolver {
  resolveSync(specifier: string, from: string): string
}
const bunResolver = (globalThis as { Bun?: Partial<BunResolver> }).Bun
const hasBunResolveSync = typeof bunResolver?.resolveSync === "function"

// Cache the in-flight Promises (not the modules) so concurrent first renders share one import each.
let cachedSync: Promise<PreactRenderToString> | undefined
let cachedStream: Promise<PreactRenderToStream> | undefined

/**
 * The consumer app root used to re-root the renderer. `nifra dev` / `nifra start` run with the CLI's
 * `process.cwd()` set to the app directory, and `nifra_render`'s subprocess `process.chdir`es to the app
 * dir before SSR, so `process.cwd()` is the app root on every Bun runtime SSR path. Read lazily so a host
 * that `chdir`s after import still sees the right root.
 */
function appRoot(): string {
  return process.cwd()
}

/** Get `preact-render-to-string` bound to the consumer app's `preact`. Cached after the first call. */
export function preactRenderToString(): Promise<PreactRenderToString> {
  if (cachedSync !== undefined) return cachedSync
  cachedSync = load<PreactRenderToString>("preact-render-to-string")
  return cachedSync
}

/** Get `preact-render-to-string/stream` bound to the consumer app's `preact`. Cached after the first call. */
export function preactRenderToStream(): Promise<PreactRenderToStream> {
  if (cachedStream !== undefined) return cachedStream
  cachedStream = load<PreactRenderToStream>("preact-render-to-string/stream")
  return cachedStream
}

/** A `Bun.resolveSync`-shaped function (specifier, from) → absolute path. */
type ResolveSync = (specifier: string, from: string) => string

/**
 * Load a renderer subpath, preferring the app-root-resolved copy under the Bun runtime. Exported for unit
 * tests: `resolve` defaults to the ambient `Bun.resolveSync` (undefined on non-Bun hosts), and a test can
 * inject a stub that succeeds (re-root branch) or throws (fallback branch) to cover both deterministically
 * without depending on the machine's node_modules layout.
 */
export async function load<T>(
  specifier: "preact-render-to-string" | "preact-render-to-string/stream",
  resolve: ResolveSync | undefined = bunResolverFn(),
): Promise<T> {
  if (resolve !== undefined) {
    // Bun runtime SSR: re-root to the app's copy so the renderer shares the components' `preact`.
    // `preact-render-to-string` is a direct DEPENDENCY of this adapter (not a peer), so whether it sits at
    // the app root depends on the installer's hoisting. When it's hoisted, app-root resolution re-roots
    // its transitive `preact` to the app's copy (the fix). When it isn't resolvable from the app root, we
    // fall through to this module's own (always-present) copy below rather than crashing.
    try {
      const resolved = resolve(specifier, appRoot())
      return (await import(resolved)) as T
    } catch {
      // App-root resolution failed; use the specifier resolved from this module's own location below.
    }
  }
  // Built bundle / Node / Deno / edge (or the Bun-resolve fallback above): the static specifier is
  // bundled (or is the only copy present). A constant bare-specifier dynamic import lets the bundler
  // include it; at runtime it resolves the copy visible to this package. Two explicit branches (not a
  // variable specifier) keep the bundler's static analysis intact.
  if (specifier === "preact-render-to-string/stream") {
    return (await import("preact-render-to-string/stream")) as T
  }
  return (await import("preact-render-to-string")) as T
}

/** The ambient `Bun.resolveSync`, or undefined on a non-Bun host (where the static import is the only path). */
function bunResolverFn(): ResolveSync | undefined {
  return hasBunResolveSync && bunResolver?.resolveSync !== undefined
    ? bunResolver.resolveSync.bind(bunResolver)
    : undefined
}
