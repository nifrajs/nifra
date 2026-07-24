/**
 * `@nifrajs/web/plugins/vite-leak-guard` — nifra's two client-leak guards, for a Vite/Rollup production
 * build.
 *
 * ## Why this exists
 *
 * nifra's production default is Bun, and that is not changing: a Vite/Rollup production build inherits
 * Rollup's build profile and gives up the Bun-native advantage nifra competes on. But some apps depend on
 * a Vite-only transform that has no Bun equivalent, and for those a Vite production build is the escape
 * hatch. The moment that hatch exists, the two client-leak guards have to come with it - they are security
 * guards, not lints: one stops secrets and database access from shipping to a browser. A second production
 * pipeline arriving WITHOUT them, or with a hastily re-implemented "mostly ported" copy, is the failure the
 * neutral module-graph seam was built to prevent.
 *
 * So this is not a second implementation. The detection logic (`detectNodeBuiltinsInClient`,
 * `detectServerOnlyInClient`) and the failure MESSAGES (`formatNodeBuiltinLeak`, `formatServerOnlyLeak`)
 * are the exact same functions the Bun build calls. This plugin only adapts Rollup's bundle shape into the
 * neutral `ClientModuleGraph` (`fromRollupBundle`) and runs them. A leak reads identically whichever
 * bundler produced it, and there is one place to change if a guard changes.
 *
 * ## How
 *
 * In `generateBundle` the whole client graph is available: each output chunk lists its `moduleIds`, and
 * `this.getModuleInfo(id)` gives each module's resolved import edges. That is exactly what
 * `fromRollupBundle` needs. Findings fail the build through Rollup's `this.error`, so the message lands in
 * the build output the same way a Bun-build throw does.
 *
 * Add it to the `plugins` of a Vite production build (the LAST plugin, so it sees the final graph):
 *
 *   // vite.config.ts (production client build)
 *   import { viteLeakGuard } from "@nifrajs/web/plugins/vite-leak-guard"
 *   export default { build: { rollupOptions: { plugins: [viteLeakGuard()] } } }
 */
import {
  detectNodeBuiltinsInClient,
  detectServerOnlyInClient,
  formatNodeBuiltinLeak,
  formatServerOnlyLeak,
} from "../build.ts"
import { fromRollupBundle, type RollupBundleLike } from "../module-graph.ts"

/**
 * The Rollup plugin-context slice this uses: `getModuleInfo` for a module's resolved imports, and `error`
 * to fail the build. Typed structurally so the file needs no `rollup`/`vite` type dependency.
 */
interface RollupPluginContext {
  getModuleInfo(id: string): {
    readonly importedIds?: readonly string[]
    readonly dynamicallyImportedIds?: readonly string[]
  } | null
  /**
   * Takes an `Error`, never a string.
   *
   * Handed a string, rolldown synthesizes its own error type and calls `Error.captureStackTrace` on a
   * plain object - which Bun rejects with "First argument must be an Error object", and THAT becomes the
   * build failure. The guard still fires, but its message is replaced by an internal one naming nothing,
   * so a real client leak reports as a stack-trace complaint. Passing an Error skips that construction
   * entirely and the message survives.
   */
  error(error: Error): never
}

/** The minimal Rollup plugin shape this returns — `generateBundle` bound to the plugin context. */
export interface LeakGuardPlugin {
  readonly name: string
  generateBundle(this: RollupPluginContext, options: unknown, bundle: RollupBundleLike): void
}

/**
 * A Vite/Rollup plugin that fails the build when server-only code or a `node:` builtin reaches the client
 * bundle - the same two guards, and the same error messages, as nifra's Bun production build.
 */
export function viteLeakGuard(): LeakGuardPlugin {
  return {
    name: "nifra:leak-guard",
    generateBundle(_options, bundle) {
      // Resolved import edges per module, straight from Rollup's graph. Dynamic imports count too: a
      // `node:`/server-only module reached only via `import()` still ships to the browser.
      const importsOf = (id: string): readonly string[] => {
        const info = this.getModuleInfo(id)
        if (info === null) return []
        return [...(info.importedIds ?? []), ...(info.dynamicallyImportedIds ?? [])]
      }
      const graph = fromRollupBundle(bundle, importsOf)
      // Node-builtin guard first, then server-only - the same order as the Bun build, so the first error a
      // dev sees is the same across pipelines when a module trips both.
      const nodeBuiltinLeak = formatNodeBuiltinLeak(detectNodeBuiltinsInClient(graph))
      if (nodeBuiltinLeak !== undefined) this.error(new Error(nodeBuiltinLeak))
      const serverOnlyLeak = formatServerOnlyLeak(detectServerOnlyInClient(graph))
      if (serverOnlyLeak !== undefined) this.error(new Error(serverOnlyLeak))
    },
  }
}
