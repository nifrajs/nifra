import { describe, expect, test } from "bun:test"
import type { PluginBuilder } from "../src/plugins/kit.ts"
import {
  type PostcssConfigLoader,
  type PostcssPluginOptions,
  type PostcssProcessor,
  postcssBunPlugin,
} from "../src/plugins/postcss.ts"

type LoadCb = (args: {
  path: string
}) => Promise<{ contents: string; loader: string }> | { contents: string; loader: string }

const SCOPED = /^[\w-]+_[0-9a-f]{8}$/

/** A stub `postcss` that records its calls and returns canned CSS - no real PostCSS needed. */
function stubProcessor(css: string) {
  const calls: Array<{ plugins: readonly unknown[]; from: string | undefined }> = []
  const postcss: PostcssProcessor = (plugins = []) => ({
    process(_source, options) {
      calls.push({ plugins, from: options.from })
      return Promise.resolve({ css })
    },
  })
  return { postcss, calls }
}

function setupPlugin(generate: "dom" | "ssr", options: PostcssPluginOptions) {
  let cssLoad: LoadCb | undefined
  postcssBunPlugin(generate, options).setup({
    onLoad: (opts: { namespace?: string }, cb: LoadCb) => {
      if (opts.namespace === undefined) cssLoad = cb
    },
    onResolve: () => {},
  } as unknown as PluginBuilder)
  return cssLoad as LoadCb
}

describe("postcssBunPlugin - plain CSS (side-effect import)", () => {
  test("dom: processes and emits the CSS as a virtual import, no default export", async () => {
    const { postcss } = stubProcessor(".a{color:red}")
    const load = setupPlugin("dom", { postcss, plugins: [] })
    const out = await load({ path: new URL("./fixtures/plain.css", import.meta.url).pathname })
    expect(out.loader).toBe("js")
    expect(out.contents).toContain("?nifra-postcss")
    expect(out.contents).not.toContain("export default")
  })

  test("ssr: resolves to an empty module (the stylesheet ships from the client build)", async () => {
    const { postcss } = stubProcessor(".a{color:red}")
    const load = setupPlugin("ssr", { postcss, plugins: [] })
    const out = await load({ path: new URL("./fixtures/plain.css", import.meta.url).pathname })
    expect(out.contents).toBe("")
  })

  test(".pcss and .postcss extensions are handled too", async () => {
    const { postcss } = stubProcessor(".a{color:red}")
    for (const ext of ["pcss", "postcss"]) {
      const out = await setupPlugin("dom", { postcss, plugins: [] })({
        path: new URL(`./fixtures/entry.${ext}`, import.meta.url).pathname,
      })
      expect(out.contents).toContain("?nifra-postcss")
    }
  })

  test("passes the configured plugins + `from` path through to PostCSS", async () => {
    const marker = { pluginName: "tailwind" }
    const { postcss, calls } = stubProcessor(".a{color:red}")
    const cssPath = new URL("./fixtures/plain.css", import.meta.url).pathname
    await setupPlugin("dom", { postcss, plugins: [marker] })({ path: cssPath })
    expect(calls[0]?.plugins).toEqual([marker])
    expect(calls[0]?.from).toBe(cssPath)
  })
})

describe("postcssBunPlugin - *.module.css (composes with CSS Modules)", () => {
  const moduleFixture = new URL("./fixtures/scoped.module.css", import.meta.url).pathname

  test("dom: exports the scoped class map AND emits the scoped CSS", async () => {
    const { postcss } = stubProcessor(".title{color:red} .card .title{margin:0}")
    const out = await setupPlugin("dom", { postcss, plugins: [] })({ path: moduleFixture })
    expect(out.contents).toContain("export default")
    expect(out.contents).toContain("?nifra-postcss")
    const map = JSON.parse(
      (out.contents.match(/export default (\{.*\})/) as RegExpMatchArray)[1] as string,
    )
    expect(map.title).toMatch(SCOPED)
    expect(map.card).toMatch(SCOPED)
  })

  test("ssr: exports the same scoped map but emits NO CSS", async () => {
    const css = ".title{color:red}"
    const domOut = await setupPlugin("dom", { postcss: stubProcessor(css).postcss, plugins: [] })({
      path: moduleFixture,
    })
    const ssrOut = await setupPlugin("ssr", { postcss: stubProcessor(css).postcss, plugins: [] })({
      path: moduleFixture,
    })
    expect(ssrOut.contents).not.toContain("?nifra-postcss")
    const pick = (s: string) =>
      JSON.parse((s.match(/export default (\{.*\})/) as RegExpMatchArray)[1] as string)
    expect(pick(domOut.contents)).toEqual(pick(ssrOut.contents))
  })
})

describe("postcssBunPlugin - config loading + errors", () => {
  test("loads plugins from postcss.config.js (via the loader) when none are passed", async () => {
    const { postcss, calls } = stubProcessor(".a{color:red}")
    const tailwind = { pluginName: "@tailwindcss/postcss" }
    const loadConfig: PostcssConfigLoader = () => Promise.resolve({ plugins: [tailwind] })
    await setupPlugin("dom", { postcss, loadConfig })({
      path: new URL("./fixtures/plain.css", import.meta.url).pathname,
    })
    expect(calls[0]?.plugins).toEqual([tailwind])
  })

  test("a PostCSS failure is attributed to the file + package (not a raw stack)", async () => {
    const throwing: PostcssProcessor = () => ({
      process() {
        return Promise.reject(new Error("Unclosed block"))
      },
    })
    const load = setupPlugin("dom", { postcss: throwing, plugins: [] })
    await expect(
      load({ path: new URL("./fixtures/broken.css", import.meta.url).pathname }),
    ).rejects.toThrow(/\[nifra\/web\] failed to process .*broken\.css: Unclosed block/)
  })
})
