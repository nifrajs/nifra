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
