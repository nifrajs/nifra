import { expect, test } from "bun:test"
import { importVite } from "../src/internal/vite-import.ts"
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

test("normalizeRolldownPlugins strips optimizeDeps.rollupOptions.jsx under rolldown", () => {
  const [wrapped] = normalizeRolldownPlugins([reactBabelPlugin()], true)
  const cfg = cfgOf(wrapped) as { optimizeDeps: Record<string, unknown> }
  // Nothing is left once jsx goes, and Vite 8 warns about even an empty `rollupOptions`, so the key goes too.
  expect(cfg.optimizeDeps).toEqual({})
  expect((wrapped as { name: string }).name).toBe("vite:react-babel")
  expect(typeof (wrapped as { transform: unknown }).transform).toBe("function")
})

test("normalizeRolldownPlugins flattens a nested plugin array - react() returns [babel, refresh]", () => {
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
  const babelCfg = cfgOf(out[0]) as { optimizeDeps: Record<string, unknown> }
  expect(babelCfg.optimizeDeps).toEqual({})
})

test("normalizeRolldownPlugins moves the rest of rollupOptions to rolldownOptions", () => {
  const plugin = {
    name: "p",
    config: () => ({
      optimizeDeps: {
        include: ["react", "react-dom"],
        rollupOptions: { jsx: { mode: "x" }, treeshake: true },
      },
    }),
  }
  expect(cfgOf(normalizeRolldownPlugins([plugin], true)[0])).toEqual({
    optimizeDeps: { include: ["react", "react-dom"], rolldownOptions: { treeshake: true } },
  })
})

test("normalizeRolldownPlugins drops rollupOptions beside rolldownOptions, as Vite ignores it there", () => {
  const plugin = {
    name: "both",
    config: () => ({
      optimizeDeps: { rollupOptions: { treeshake: false }, rolldownOptions: { treeshake: true } },
    }),
  }
  expect(cfgOf(normalizeRolldownPlugins([plugin], true)[0])).toEqual({
    optimizeDeps: { rolldownOptions: { treeshake: true } },
  })
})

test("normalizeRolldownPlugins migrates ssr.optimizeDeps and returns other configs as they came", () => {
  const ssr = {
    name: "ssr",
    config: () => ({ ssr: { noExternal: ["x"], optimizeDeps: { rollupOptions: { jsx: {} } } } }),
  }
  expect(cfgOf(normalizeRolldownPlugins([ssr], true)[0])).toEqual({
    ssr: { noExternal: ["x"], optimizeDeps: {} },
  })
  const returned = { optimizeDeps: { include: ["react"] } }
  const plain = { name: "plain", config: () => returned }
  expect(cfgOf(normalizeRolldownPlugins([plain], true)[0])).toBe(returned)
})

test("Vite 8 resolves a normalized plugin-react config hook without the rollupOptions warning", async () => {
  type Resolve = (config: Record<string, unknown>, command: string) => Promise<unknown>
  const vite = await importVite<{ resolveConfig: Resolve; rolldownVersion?: string }>()
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(String(args[0]))
  const count = async (plugins: readonly unknown[], command: string): Promise<number> => {
    warnings.length = 0
    await vite.resolveConfig({ configFile: false, logLevel: "silent", plugins }, command)
    return warnings.filter((w) => w.includes("rollupOptions")).length
  }
  try {
    const isRolldown = vite.rolldownVersion !== undefined
    expect(isRolldown).toBe(true)
    for (const command of ["serve", "build"]) {
      const raw = [
        reactBabelPlugin(),
        { name: "empty", config: () => ({ optimizeDeps: { rollupOptions: {} } }) },
      ]
      expect(await count(raw, command)).toBeGreaterThan(0)
      expect(await count(normalizeRolldownPlugins(raw, isRolldown), command)).toBe(0)
    }
  } finally {
    console.warn = warn
  }
})

test("normalizeRolldownPlugins is a no-op on non-rolldown Vite", () => {
  const plugin = reactBabelPlugin()
  const result = normalizeRolldownPlugins([plugin], false)
  expect(result[0]).toBe(plugin) // same reference: untouched
  const cfg = cfgOf(result[0]) as { optimizeDeps: { rollupOptions: Record<string, unknown> } }
  expect("jsx" in cfg.optimizeDeps.rollupOptions).toBe(true) // esbuild/rollup path still wants it
})

test("normalizeRolldownPlugins passes through plugins without a config hook, and async config", () => {
  // No config hook → returned as-is.
  const bare = { name: "bare", transform: () => "" }
  expect(normalizeRolldownPlugins([bare], true)[0]).toBe(bare)
  // A non-object plugin entry (e.g. false/undefined from a conditional) is left alone.
  expect(normalizeRolldownPlugins([false, null], true)).toEqual([false, null])
})

test("normalizeRolldownPlugins wraps an object-form config hook and preserves its order", () => {
  // Vite allows `config: { handler, order }` for hook ordering. The wrapper must keep the object shape -
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
  expect(wrapped.config.handler()).toEqual({ optimizeDeps: {} })
})

test("normalizeRolldownPlugins handles a promise-returning config hook", async () => {
  const plugin = {
    name: "async",
    config: async () => ({ optimizeDeps: { rollupOptions: { jsx: { mode: "automatic" } } } }),
  }
  const wrapped = normalizeRolldownPlugins([plugin], true)[0] as { config: () => Promise<unknown> }
  expect(await wrapped.config()).toEqual({ optimizeDeps: {} })
})
