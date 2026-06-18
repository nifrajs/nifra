import { describe, expect, test } from "bun:test"
import { plugin } from "bun"
import { vueAdapter } from "../src/index.ts"
import { compileVue, compileVueStyles, vueBunPlugin } from "../src/plugin.ts"

const SFC = `<script>
export const loader = () => ({ x: 1 })
export const meta = { title: "T" }
</script>
<script setup>
defineProps(["data"])
</script>
<template><p id="x">{{ data.x }}</p></template>
<style scoped>p { color: red }</style>`

const toText = (s: ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>) =>
  Promise.resolve(s).then((stream) => new Response(stream).text())

type LoadCb = (args: {
  path: string
}) => Promise<{ contents: string; loader: string }> | { contents: string; loader: string }
type ResolveCb = (args: { path: string }) => { path: string; namespace: string }

/**
 * Drive `vueBunPlugin(generate).setup` with a fake Bun build, capturing the handlers it registers: the
 * `.vue` compiler (non-namespaced onLoad), the virtual `?vue-css` CSS loader (namespaced onLoad), and
 * the `?vue-css` resolver. Lets the tests exercise the real plugin wiring without a full `Bun.build`.
 */
function setupVuePlugin(generate: "dom" | "ssr") {
  let vueLoad: LoadCb | undefined
  let cssLoad: LoadCb | undefined
  let cssResolve: ResolveCb | undefined
  vueBunPlugin(generate).setup({
    onLoad: (opts: { namespace?: string }, cb: LoadCb) => {
      if (opts.namespace === undefined) vueLoad = cb
      else cssLoad = cb
    },
    onResolve: (_opts: unknown, cb: ResolveCb) => {
      cssResolve = cb
    },
  } as never)
  return { vueLoad, cssLoad, cssResolve }
}

describe("compileVue", () => {
  test("ssr: binds ssrRender, preserves loader/meta exports + a default component", () => {
    const code = compileVue(SFC, "/routes/page.vue", "ssr")
    expect(code).toContain("_sfc_main.ssrRender = ssrRender")
    expect(code).toContain("export default _sfc_main")
    expect(code).toMatch(/export const loader/)
    expect(code).toMatch(/export const meta/)
    // The SSR *module* carries no CSS — the scoped stylesheet ships from the client build (via
    // compileVueStyles). But the markup is still scoped: the `data-v-<id>` attribute + `__scopeId`
    // are baked in so the SSR HTML matches the bundled scoped selectors.
    expect(code).not.toContain("color: red")
    expect(code).toContain("__scopeId")
    expect(code).toMatch(/data-v-[0-9a-f]{8}/)
  })

  test("dom: binds render (client output), not ssrRender", () => {
    const code = compileVue(SFC, "/routes/page.vue", "dom")
    expect(code).toContain("_sfc_main.render = render")
    expect(code).not.toContain("ssrRender")
  })

  test("template-only SFC compiles to an empty component + render", () => {
    const code = compileVue("<template><h1>hi</h1></template>", "/routes/x.vue", "dom")
    expect(code).toContain("_sfc_main")
    expect(code).toContain("export default _sfc_main")
  })

  test("surfaces a parse error clearly", () => {
    // Mismatched tags fail at parse (before template compilation).
    expect(() => compileVue("<template><div></span></template>", "/r/bad.vue", "ssr")).toThrow(
      /failed to parse/,
    )
  })

  test("surfaces a template compile error clearly", () => {
    // Parses fine, but `v-if` with no expression is a template-compiler error.
    expect(() => compileVue("<template><div v-if></div></template>", "/r/c.vue", "ssr")).toThrow(
      /template error/,
    )
  })

  test("vueBunPlugin.setup registers an onLoad that compiles .vue (and strips a ?query suffix)", async () => {
    const { vueLoad } = setupVuePlugin("dom")
    expect(vueLoad).toBeDefined()
    const fixture = new URL("./fixtures/page.vue", import.meta.url).pathname
    const out = await (vueLoad as LoadCb)({ path: `${fixture}?v=1` }) // ?query is stripped before reading
    expect(out.loader).toBe("ts")
    expect(out.contents).toContain("_sfc_main.render = render")
  })
})

describe("compileVueStyles — scoped CSS extraction", () => {
  test("scoped <style>: selectors rewritten to a [data-v-<id>] attribute selector", () => {
    const css = compileVueStyles(SFC, "/routes/page.vue")
    expect(css).toContain("color: red")
    expect(css).toMatch(/\[data-v-[0-9a-f]{8}\]/) // scoped attribute selector
  })

  test("non-scoped <style>: CSS emitted verbatim (no scope attribute)", () => {
    const css = compileVueStyles(
      `<template><p>x</p></template><style>p { color: red }</style>`,
      "/r/global.vue",
    )
    expect(css).toContain("color: red")
    expect(css).not.toContain("[data-v-")
  })

  test("style-less SFC: empty string (nothing to bundle)", () => {
    expect(compileVueStyles("<template><p>x</p></template>", "/r/none.vue")).toBe("")
  })
})

describe("vueBunPlugin — scoped <style> round-trip", () => {
  const fixture = new URL("./fixtures/page.vue", import.meta.url).pathname

  test("dom: the .vue import emits a virtual ?vue-css module that loads the scoped stylesheet", async () => {
    const { vueLoad, cssLoad, cssResolve } = setupVuePlugin("dom")
    // 1) compiling the .vue appends an `import "<path>?vue-css"` so the bundler pulls in the CSS.
    const out = await (vueLoad as LoadCb)({ path: fixture })
    expect(out.contents).toContain(`${fixture}?vue-css`)
    // 2) the resolver routes that specifier into the nifra-vue-css namespace.
    const resolved = (cssResolve as ResolveCb)({ path: `${fixture}?vue-css` })
    expect(resolved.namespace).toBe("nifra-vue-css")
    // 3) the namespaced loader returns the compiled, scoped stylesheet (css loader).
    const css = await (cssLoad as LoadCb)({ path: resolved.path })
    expect(css.loader).toBe("css")
    expect(css.contents).toMatch(/#title\[data-v-[0-9a-f]{8}\]/) // scoped selector
    expect(css.contents).toContain("rebeccapurple")
  })

  test("ssr: emits no CSS import (the stylesheet ships from the client build), markup stays scoped", async () => {
    const { vueLoad } = setupVuePlugin("ssr")
    const out = await (vueLoad as LoadCb)({ path: fixture })
    expect(out.contents).not.toContain("?vue-css")
    expect(out.contents).toContain("__scopeId") // SSR HTML still carries data-v-<id>
  })
})

describe("vueBunPlugin — end-to-end SSR of a real .vue route", () => {
  // Register the SSR compiler globally, then import a .vue fixture: the dynamic import is compiled by
  // the plugin, giving us the component (default) + the loader/meta named exports — proof the compiled
  // SFC renders through the unchanged Vue adapter.
  plugin(vueBunPlugin("ssr"))

  test("compiled SFC: named exports work + the component SSRs the loader data", async () => {
    const mod = (await import("./fixtures/page.vue")) as {
      default: unknown
      loader: () => Promise<{ greeting: string }>
      meta: { title: string }
    }
    expect(mod.meta.title).toBe("Vue SFC route")
    const data = await mod.loader()
    expect(data.greeting).toBe("hello from the SFC loader")

    const html = await toText(vueAdapter.renderToStream([mod.default], { data, pending: false }))
    expect(html).toContain('id="title"')
    expect(html).toContain("hello from the SFC loader") // {{ data.greeting }} rendered server-side
  })
})
