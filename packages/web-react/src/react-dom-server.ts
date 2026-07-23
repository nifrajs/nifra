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

interface RuntimeProcess {
  getBuiltinModule?(specifier: string): unknown
}

function dirnamePortable(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return slash <= 0 ? "." : path.slice(0, slash)
}

function runtimeRealpath(path: string): string {
  const runtimeProcess = (globalThis as { process?: RuntimeProcess }).process
  const fs = runtimeProcess?.getBuiltinModule?.("node:fs") as
    | { realpathSync?: (value: string) => string }
    | undefined
  return fs?.realpathSync?.(path) ?? path
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
 * The dual-React crash, caught on the RESOLVED graph instead of after it detonates.
 *
 * The re-root above makes `react-dom/server` load from the app root, which is right almost always. What it
 * cannot guarantee is that react-dom then pulls in the SAME physical `react` the route components import -
 * a nested `react` under react-dom, or a components tree resolving react elsewhere, still yields two cores.
 * Two cores is two hook dispatchers, and the renderer sees a null (or foreign) one: the SSR throws
 * `resolveDispatcher().useState is null` from deep inside react-dom-server, naming a React internal and
 * nothing about the two directories that actually caused it. That is hours of inference from a message
 * that points nowhere useful.
 *
 * `nifra doctor` checks what is INSTALLED; this checks what SSR actually RESOLVED, which is the only thing
 * that can catch a duplicate the two dev pipelines introduce (Bun for SSR, Vite for the client) rather
 * than the install. It compares the realpath of the `react` react-dom will render with against the
 * `react` the components import, and if they differ throws with BOTH paths - turning a five-hour hunt into
 * a five-second read. Silent when they agree, which is the single-copy common case.
 *
 * Never manufactures a failure: if either side cannot be resolved it returns, because a resolver that
 * cannot answer is not evidence of a duplicate. Exported for direct unit testing.
 */
export function assertSingleReactCore(
  reactDomServerPath: string,
  resolve: ResolveSync,
  realpath: (path: string) => string = runtimeRealpath,
): void {
  let rendererReact: string
  let componentsReact: string
  try {
    // The `react` react-dom/server itself resolves - the core whose dispatcher the renderer sets.
    rendererReact = realpath(resolve("react", dirnamePortable(reactDomServerPath)))
    // The `react` the app's route components import - the core they call hooks on.
    componentsReact = realpath(resolve("react", appRoot()))
  } catch {
    return
  }
  if (rendererReact === componentsReact) return
  throw new Error(
    "[nifra/web-react] two copies of React reached SSR, so hooks render against a null dispatcher " +
      "(the `resolveDispatcher().useState is null` crash). react-dom renders with a DIFFERENT React " +
      "than your components import:\n" +
      `  react-dom's react:  ${rendererReact}\n` +
      `  components' react:  ${componentsReact}\n` +
      "Module identity is path-based, so two copies fail even at the same version. Dedupe react to one " +
      "physical copy - usually a single hoisted install at the workspace root (`nifra doctor` locates " +
      "the duplicate). A Vite `resolve.dedupe`/alias fixes only the client bundle, not this SSR path.",
  )
}

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
      // Before returning the module, verify the react-dom we just re-rooted shares the components' React.
      // The re-root fixes the common case; this catches the residual duplicate loudly, with both paths,
      // instead of leaving it to throw a dispatcher-null error on the first hook render. Runs once (this
      // whole function is cached), dev/unbundled Bun only (the branch `resolve` gates).
      assertSingleReactCore(resolved, resolve)
      return (await import(resolved)) as ReactDomServer
    } catch (err) {
      // A genuine duplicate is surfaced (re-thrown with both paths); any other failure (react-dom not at
      // the app root, an odd nested layout) falls through to the bundled specifier rather than crashing.
      if (err instanceof Error && err.message.includes("two copies of React")) throw err
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
