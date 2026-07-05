import { expect, test } from "bun:test"
import { normalizeRolldownPlugins } from "../src/vite.ts"

// Mirrors `@vitejs/plugin-react@4.x`'s `config` hook output under rolldown-vite: it injects the stale
// `optimizeDeps.rollupOptions.jsx` key that Vite 8's rolldown dep-optimizer rejects with the scary
// "Invalid input options … 'jsx' Invalid key" warning. #6.
const reactBabelPlugin = () => ({
  name: "vite:react-babel",
  config: () => ({ optimizeDeps: { rollupOptions: { jsx: { mode: "automatic" } } } }),
  // A second, unrelated hook the wrapper must leave untouched.
  transform: (code: string) => code,
})

const cfgOf = (plugin: unknown): unknown => {
  const p = plugin as { config: () => unknown }
  return p.config()
}

test("normalizeRolldownPlugins strips optimizeDeps.rollupOptions.jsx under rolldown [#6]", () => {
  const [wrapped] = normalizeRolldownPlugins([reactBabelPlugin()], true)
  const cfg = cfgOf(wrapped) as { optimizeDeps: { rollupOptions: Record<string, unknown> } }
  // The dead `jsx` key is gone — no more "Invalid key" warning.
  expect("jsx" in cfg.optimizeDeps.rollupOptions).toBe(false)
  // optimizeDeps.rollupOptions itself survives (now empty here), and the plugin's other props are kept.
  expect(cfg.optimizeDeps.rollupOptions).toEqual({})
  expect((wrapped as { name: string }).name).toBe("vite:react-babel")
  expect(typeof (wrapped as { transform: unknown }).transform).toBe("function")
})

test("normalizeRolldownPlugins flattens a nested plugin array — react() returns [babel, refresh] [#6]", () => {
  // The real shape: `@vitejs/plugin-react`'s `react()` returns an ARRAY of plugins, and `nifra.config.ts`
  // writes `vitePlugins = [react()]`, so the list arrives NESTED (`[[babel, refresh]]`). The earlier tests
  // only passed a flat `[plugin]`, which is why the "Invalid key jsx" warning shipped: without flattening,
  // `.map` sees the inner array (no `config` hook), leaves it, and Vite runs the un-stripped babel hook.
  const react = () => [
    reactBabelPlugin(),
    { name: "vite:react-refresh", config: () => ({ optimizeDeps: { include: ["react"] } }) },
  ]
  const out = normalizeRolldownPlugins([react()], true)
  // Flattened to the top level, so both inner plugins are reachable…
  expect(out.map((p) => (p as { name: string }).name)).toEqual([
    "vite:react-babel",
    "vite:react-refresh",
  ])
  // …and the babel plugin's jsx key is actually stripped now.
  const babelCfg = cfgOf(out[0]) as { optimizeDeps: { rollupOptions: Record<string, unknown> } }
  expect("jsx" in babelCfg.optimizeDeps.rollupOptions).toBe(false)
})

test("normalizeRolldownPlugins preserves a real optimizeDeps include alongside the dropped jsx [#6]", () => {
  const plugin = {
    name: "p",
    config: () => ({
      optimizeDeps: {
        include: ["react", "react-dom"],
        rollupOptions: { jsx: { mode: "x" }, treeshake: true },
      },
    }),
  }
  const cfg = cfgOf(normalizeRolldownPlugins([plugin], true)[0]) as {
    optimizeDeps: { include: string[]; rollupOptions: Record<string, unknown> }
  }
  expect(cfg.optimizeDeps.include).toEqual(["react", "react-dom"]) // unrelated keys untouched
  expect(cfg.optimizeDeps.rollupOptions).toEqual({ treeshake: true }) // only jsx dropped
})

test("normalizeRolldownPlugins is a no-op on non-rolldown Vite [#6]", () => {
  const plugin = reactBabelPlugin()
  const result = normalizeRolldownPlugins([plugin], false)
  expect(result[0]).toBe(plugin) // same reference: untouched
  const cfg = cfgOf(result[0]) as { optimizeDeps: { rollupOptions: Record<string, unknown> } }
  expect("jsx" in cfg.optimizeDeps.rollupOptions).toBe(true) // esbuild/rollup path still wants it
})

test("normalizeRolldownPlugins passes through plugins without a config hook, and async config [#6]", () => {
  // No config hook → returned as-is.
  const bare = { name: "bare", transform: () => "" }
  expect(normalizeRolldownPlugins([bare], true)[0]).toBe(bare)
  // A non-object plugin entry (e.g. false/undefined from a conditional) is left alone.
  expect(normalizeRolldownPlugins([false, null], true)).toEqual([false, null])
})

test("normalizeRolldownPlugins wraps an object-form config hook and preserves its order [#6]", () => {
  // Vite allows `config: { handler, order }` for hook ordering. The wrapper must keep the object shape —
  // collapsing it to a bare function would silently drop the `order`.
  const plugin = {
    name: "obj-hook",
    config: {
      order: "pre",
      handler: () => ({ optimizeDeps: { rollupOptions: { jsx: { mode: "automatic" } } } }),
    },
  }
  const [wrapped] = normalizeRolldownPlugins([plugin], true) as [
    { config: { order: string; handler: () => unknown } },
  ]
  expect(wrapped.config.order).toBe("pre") // ordering preserved
  expect(typeof wrapped.config.handler).toBe("function")
  const cfg = wrapped.config.handler() as {
    optimizeDeps: { rollupOptions: Record<string, unknown> }
  }
  expect("jsx" in cfg.optimizeDeps.rollupOptions).toBe(false) // jsx still stripped
})

test("normalizeRolldownPlugins handles a promise-returning config hook [#6]", async () => {
  const plugin = {
    name: "async",
    config: async () => ({ optimizeDeps: { rollupOptions: { jsx: { mode: "automatic" } } } }),
  }
  const wrapped = normalizeRolldownPlugins([plugin], true)[0] as { config: () => Promise<unknown> }
  const cfg = (await wrapped.config()) as {
    optimizeDeps: { rollupOptions: Record<string, unknown> }
  }
  expect("jsx" in cfg.optimizeDeps.rollupOptions).toBe(false)
})
