// A Vite `config` hook is a plain function or the object form `{ handler, order }` Vite accepts for hook
// ordering; plugins are typed structurally (no `vite` type dep) and every other field is kept by spread.
type ConfigFn = (config: unknown, env: unknown) => unknown

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * Move a plugin's `optimizeDeps.rollupOptions` to `optimizeDeps.rolldownOptions` under rolldown-vite and
 * drop its `jsx` key, so Vite 8 warns about neither on `nifra dev` or a Vite build.
 *
 * Both are version-skew artifacts of plugins such as `@vitejs/plugin-react@4.x`, which still emit
 * `optimizeDeps.rollupOptions.jsx`:
 *
 * - Vite 8 renamed the dep optimizer's options to `rolldownOptions` and moved jsx under `transform.jsx`,
 *   so a stale `jsx` key prints `Invalid input options … "jsx" Invalid key`. The route JSX transform runs
 *   through the plugin's own `transform` hook and pre-bundled deps almost never hold raw JSX, so the key
 *   is dead and dropping it changes no behavior.
 * - Vite 8 reads `rollupOptions` there only as a deprecated alias of `rolldownOptions` and warns on every
 *   resolve, even for `{}`. The remaining keys move to `rolldownOptions`; when the same object already
 *   sets `rolldownOptions`, Vite ignores the alias, so it is dropped. `ssr.optimizeDeps` gets the same.
 *
 * Only a plugin's `config` hook output is rewritten, never mutated, and only under rolldown-vite.
 * Non-rolldown Vite is passed through verbatim.
 *
 * FLATTEN FIRST: a plugin factory may return an ARRAY of plugins - `@vitejs/plugin-react@4.x`'s `react()`
 * returns `[vite:react-babel, vite:react-refresh]`, and it's `vite:react-babel`'s `config` hook that emits
 * the offending `optimizeDeps.rollupOptions.jsx`. `nifra.config.ts` writes `vitePlugins = [react()]`, so the
 * plugin list arrives NESTED (`[[babel, refresh]]`). Without flattening, `.map` sees the inner array (which
 * has no `config`), leaves it untouched, and Vite - which flattens plugin arrays itself before running them
 * - then executes the un-stripped babel hook, so the warning survives. Flattening here (Vite accepts a flat
 * list identically) is what lets the strip reach every real plugin.
 */
export function normalizeRolldownPlugins(
  plugins: readonly unknown[],
  isRolldown: boolean,
): readonly unknown[] {
  if (!isRolldown) return plugins
  const migrateDepOptions = (deps: unknown): unknown => {
    if (!isRecord(deps)) return deps
    const { rollupOptions, ...rest } = deps
    if (rollupOptions === undefined) return deps
    // Vite skips the alias when the same object sets rolldownOptions (mergeConfigRecursively).
    if (rest.rolldownOptions || rollupOptions === null) return rest
    if (!isRecord(rollupOptions)) return { ...rest, rolldownOptions: rollupOptions }
    const { jsx: _dropped, ...kept } = rollupOptions
    return Object.keys(kept).length === 0 ? rest : { ...rest, rolldownOptions: kept }
  }
  const migrateConfig = (returned: unknown): unknown => {
    if (!isRecord(returned)) return returned
    const ssr = isRecord(returned.ssr) ? returned.ssr : undefined
    const deps = migrateDepOptions(returned.optimizeDeps)
    const ssrDeps = migrateDepOptions(ssr?.optimizeDeps)
    if (deps === returned.optimizeDeps && ssrDeps === ssr?.optimizeDeps) return returned
    const out = { ...returned }
    if (deps !== returned.optimizeDeps) out.optimizeDeps = deps
    if (ssr !== undefined && ssrDeps !== ssr.optimizeDeps)
      out.ssr = { ...ssr, optimizeDeps: ssrDeps }
    return out
  }
  return plugins.flat(Number.POSITIVE_INFINITY).map((plugin) => {
    if (!isRecord(plugin)) return plugin
    // `config` may be a plain function or the object form `{ handler, order }`. Wrap the handler either way.
    const hook = plugin.config
    const objectHook = isRecord(hook) ? hook : undefined
    const handler = typeof hook === "function" ? hook : objectHook?.handler
    if (typeof handler !== "function") return plugin
    const wrappedHandler: ConfigFn = (config, env) => {
      const returned: unknown = handler(config, env)
      // The hook may return a promise - normalize both shapes.
      return returned instanceof Promise ? returned.then(migrateConfig) : migrateConfig(returned)
    }
    // Preserve the ORIGINAL shape: a function stays a function; the object form keeps its `order`
    // (collapsing `{ handler, order }` to a bare function would silently drop the hook ordering).
    return {
      ...plugin,
      config:
        objectHook === undefined ? wrappedHandler : { ...objectHook, handler: wrappedHandler },
    }
  })
}
