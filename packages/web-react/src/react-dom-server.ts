/**
 * Resolve `react-dom/server` so it shares ONE React core with the route components — the fix for the
 * dual-React SSR crash (`resolveDispatcher().useState` is null / "Invalid hook call: mismatching versions
 * of React and the renderer").
 *
 * WHY this exists: under Bun **runtime** SSR (`nifra dev`, `nifra start`, `nifra_render`, all in-process),
 * a static `import "react-dom/server"` in this adapter is resolved by Bun from THIS package's own
 * (symlinked) node_modules — which can be a DIFFERENT physical `react` than the one the consumer app's
 * route components import. Two React cores → two hook dispatchers → the renderer's dispatcher is the wrong
 * (or null) one → the crash. Resolving `react-dom/server` from the consumer **app root** instead makes
 * react-dom pull the app's `react` transitively, matching the components' `react`: a single core, a single
 * dispatcher, no crash. (Empirically verified against a two-copy install fixture — see
 * test/dual-react.test.ts.)
 *
 * Guarding precisely so the BUILT path is untouched: a bundle is detected two ways — `Bun.resolveSync` is
 * unavailable (Node / Deno / Cloudflare / Vercel), OR `buildServer` tagged the output with
 * `process.env.NIFRA_SSR_BUNDLED` (a `target:"bun"` bundle DOES keep `Bun.resolveSync` under the Bun
 * runtime, so the resolver test alone can't see it). In either case the build already bundled+deduped a
 * single `react-dom` (buildServer's `reactDedupePlugin` pins `react`), so the static `import` is correct.
 * Re-rooting a bundle would instead re-import a SECOND react-dom from disk — a second React core whose hook
 * dispatcher is null for the bundled components → the `…H.useRef of null` SSR crash. The app-root re-root
 * therefore runs ONLY under an UNBUNDLED Bun runtime (nifra dev/start, nifra_render), where the duplication
 * can occur, `Bun.resolveSync` exists, and no bundle marker is present.
 */

import type { ReactNode } from "react"

/** The slice of `react-dom/server` this adapter uses. Typed locally so the dynamic import (which Bun
 * resolves to an absolute path string) stays strict — no `any` crosses the boundary. */
export interface ReactDomServer {
  renderToString(node: ReactNode): string
  renderToReadableStream(node: ReactNode): Promise<ReadableStream<Uint8Array>>
}

// `globalThis.Bun` isn't in the ambient lib types; narrow exactly the one method we need so we never
// reach for `any`. `resolveSync(specifier, from)` returns the absolute path the specifier resolves to
// when required from `from` — Bun's runtime resolver, the only lever that re-roots a BARE specifier
// (a runtime `Bun.plugin` onResolve does NOT fire for bare specifiers like `react-dom/server`, verified).
interface BunResolver {
  resolveSync(specifier: string, from: string): string
}
const bunResolver = (globalThis as { Bun?: Partial<BunResolver> }).Bun
const hasBunResolveSync = typeof bunResolver?.resolveSync === "function"

// Resolve once and cache: the module identity is stable for the process lifetime, and re-resolving per
// render would pay the import cost on every page. A Promise is cached (not the module) so concurrent
// first renders share a single in-flight import rather than racing N imports.
let cached: Promise<ReactDomServer> | undefined

/**
 * The consumer app root used to re-root `react-dom/server`. `nifra dev` / `nifra start` run with the CLI's
 * `process.cwd()` set to the app directory, and `nifra_render`'s subprocess `process.chdir`es to the app
 * dir before SSR (see packages/cli/src/mcp-render.ts), so `process.cwd()` is the app root on every Bun
 * runtime SSR path. Read lazily (not at module load) so a host that `chdir`s after import still sees the
 * right root on first render.
 */
function appRoot(): string {
  return process.cwd()
}

/**
 * Get `react-dom/server` bound to the consumer app's React. Cached after the first call. Under the Bun
 * runtime, dynamically imports the copy resolved from the app root; otherwise (built/bundled, or a non-Bun
 * host) loads the statically-bundled `react-dom/server`.
 */
export function reactDomServer(): Promise<ReactDomServer> {
  if (cached !== undefined) return cached
  cached = loadReactDomServer()
  return cached
}

/** A `Bun.resolveSync`-shaped function (specifier, from) → absolute path. */
type ResolveSync = (specifier: string, from: string) => string

/**
 * Load `react-dom/server`, preferring the app-root-resolved copy under the Bun runtime. Exported for unit
 * tests: `resolve` defaults to the ambient `Bun.resolveSync` (undefined on non-Bun hosts), and a test can
 * inject a stub that succeeds (re-root branch) or throws (fallback branch) to cover both deterministically
 * without depending on the machine's node_modules layout.
 */
export async function loadReactDomServer(
  resolve: ResolveSync | undefined = bunResolverFn(),
): Promise<ReactDomServer> {
  if (resolve !== undefined) {
    // Bun runtime SSR: re-root to the app's copy so react-dom shares the components' React. `react-dom`
    // is a PEER dependency of this adapter, so a correct install puts it at the app root and this
    // resolves. If it somehow doesn't (an unusual nested layout), fall through to the bundled specifier
    // rather than crashing — degraded (possible duplicate) but never a hard failure.
    try {
      const resolved = resolve("react-dom/server", appRoot())
      return (await import(resolved)) as ReactDomServer
    } catch {
      // App-root resolution failed; use the specifier resolved from this module's own location below.
    }
  }
  // Built bundle / Node / Deno / edge (or the Bun-resolve fallback above): the static import is
  // bundled+deduped (or is the only react-dom present). A bare-specifier dynamic import here lets the
  // bundler include it (it's a constant), and at runtime resolves the copy visible to this package.
  return (await import("react-dom/server")) as ReactDomServer
}

/**
 * The resolver `loadReactDomServer` uses by default, or `undefined` when re-rooting must NOT happen — a
 * non-Bun host (no `Bun.resolveSync`; the static import is the only path) OR a BUNDLED SSR output.
 * `buildServer` defines `process.env.NIFRA_SSR_BUNDLED` to `"1"` in every bundle, where react-dom is
 * already inlined + deduped to the components' React (reactDedupePlugin); re-rooting there would re-import
 * a SECOND react-dom from disk (a `target:"bun"` bundle still has `Bun.resolveSync`), giving the bundled
 * components a foreign/null hook dispatcher → the `…H.useRef of null` crash. The marker is read here (per
 * call, not at module load) so it stays driveable from a test. Unbundled Bun runtimes don't set it, so
 * dev/start still re-root. Exported for unit testing the gate. */
export function bunResolverFn(): ResolveSync | undefined {
  if (process.env.NIFRA_SSR_BUNDLED === "1") return undefined
  return hasBunResolveSync && bunResolver?.resolveSync !== undefined
    ? bunResolver.resolveSync.bind(bunResolver)
    : undefined
}
