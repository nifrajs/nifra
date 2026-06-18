import { describe, expect, test } from "bun:test"
import { svelteBunPlugin } from "../src/plugin.ts"

/**
 * Unit tests for the `.svelte` compiler Bun plugin — focused on the CSS pipeline (scoped `<style>` →
 * a virtual `?svelte-css` module on the client build; nothing on SSR). The adapter itself (SSR/hydrate)
 * is verified end-to-end via `examples/routing-svelte`; these cover the plugin's build-time contract.
 */

type LoadResult = { contents: string; loader: string }
type LoadCb = (args: { path: string }) => Promise<LoadResult> | LoadResult
type ResolveCb = (args: { path: string }) => { path: string; namespace: string }

/**
 * Drive `svelteBunPlugin(generate).setup` with a fake Bun build, capturing the handlers it registers:
 * the `.svelte` compiler (non-namespaced onLoad), the virtual `?svelte-css` CSS loader (namespaced
 * onLoad), and the `?svelte-css` resolver. Exercises the real wiring without a full `Bun.build`.
 */
function setupSveltePlugin(generate: "dom" | "ssr") {
  let svelteLoad: LoadCb | undefined
  let cssLoad: LoadCb | undefined
  let cssResolve: ResolveCb | undefined
  svelteBunPlugin(generate).setup({
    onLoad: (opts: { namespace?: string }, cb: LoadCb) => {
      if (opts.namespace === undefined) svelteLoad = cb
      else cssLoad = cb
    },
    onResolve: (_opts: unknown, cb: ResolveCb) => {
      cssResolve = cb
    },
  } as never)
  return { svelteLoad, cssLoad, cssResolve }
}

describe("svelteBunPlugin", () => {
  const fixture = new URL("./fixtures/page.svelte", import.meta.url).pathname

  test("dom: compiles to client JS + emits a virtual ?svelte-css module with the scoped stylesheet", async () => {
    const { svelteLoad, cssLoad, cssResolve } = setupSveltePlugin("dom")
    expect(svelteLoad).toBeDefined()
    // 1) compiling the .svelte (with a ?query suffix, which is stripped) appends an
    //    `import "<path>?svelte-css"` so the bundler pulls the scoped CSS into the app stylesheet.
    const out = await (svelteLoad as LoadCb)({ path: `${fixture}?v=1` })
    expect(out.loader).toBe("js")
    expect(out.contents).toContain(`${fixture}?svelte-css`)
    // 2) the resolver routes that specifier into the nifra-svelte-css namespace.
    const resolved = (cssResolve as ResolveCb)({ path: `${fixture}?svelte-css` })
    expect(resolved.namespace).toBe("nifra-svelte-css")
    // 3) the namespaced loader returns the compiled, scoped stylesheet (css loader). Svelte scopes
    //    `#title` to `#title.svelte-<hash>` and bakes the class into the markup.
    const css = await (cssLoad as LoadCb)({ path: resolved.path })
    expect(css.loader).toBe("css")
    expect(css.contents).toMatch(/\.svelte-[0-9a-z]+/) // scoped class
    expect(css.contents).toContain("rebeccapurple")
  })

  test("ssr: compiles to server JS, emits no CSS (the stylesheet ships from the client build)", async () => {
    const { svelteLoad } = setupSveltePlugin("ssr")
    const out = await (svelteLoad as LoadCb)({ path: fixture })
    expect(out.loader).toBe("js")
    expect(out.contents).not.toContain("?svelte-css")
  })

  test("dom: a style-less component emits no CSS import (the compile yields no css.code)", async () => {
    const { svelteLoad } = setupSveltePlugin("dom")
    const plain = new URL("./fixtures/plain.svelte", import.meta.url).pathname
    const out = await (svelteLoad as LoadCb)({ path: plain })
    expect(out.loader).toBe("js")
    expect(out.contents).not.toContain("?svelte-css")
  })
})
