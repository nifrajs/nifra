import { hash8, reproduciblePath } from "@nifrajs/web/plugins/kit"
import {
  type BindingMetadata,
  compileScript,
  compileStyle,
  compileTemplate,
  parse,
} from "@vue/compiler-sfc"
import type { BunPlugin } from "bun"

/**
 * `@nifrajs/web-vue/plugin` — the `.vue` Single-File-Component compiler Bun plugin, in its OWN module (no
 * `.vue` imports), so the SSR preload registers it BEFORE any `.vue` file loads. Mirrors
 * `@nifrajs/web-svelte/plugin`: pass `"dom"` for the client bundle (`buildClient({ plugins: [...] })`) and
 * preload `"ssr"` for the server (`bun --preload`). Needs `@vue/compiler-sfc` (a peer that matches your
 * `vue` version). The compiler runs at build time, on `.vue` files only.
 */

const COMPONENT = "_sfc_main"
const STYLE_SUFFIX = "?vue-css"
const STYLE_NS = "nifra-vue-css"

/**
 * Deterministic 8-hex scope id for `data-v-<id>`. Hashes the cwd-relative path (not the machine's
 * absolute one) via the shared plugin kit, so the same `.vue` file yields the same scope id across
 * machines/CI — and so `compileVue` (markup) and `compileVueStyles` (CSS) always agree.
 */
function scopeId(filename: string): string {
  return hash8(reproduciblePath(filename))
}

const templateErrorMessage = (e: string | { message?: string }): string =>
  typeof e === "string" ? e : (e.message ?? "unknown template error")

/**
 * Compile a `.vue` SFC to a JS module: the component as the **default export**, plus the plain
 * `<script>`'s named exports (`loader`/`action`/`meta` — nifra's route convention) preserved as-is.
 * `<template>` compiles to a `render` (dom) or `ssrRender` (ssr) function bound onto the component.
 *
 * Scoped `<style>`: when any style block is `scoped`, the template gets the `data-v-<id>` scope
 * attribute (in both dom + ssr output, so SSR markup matches the scoped CSS) and the component is
 * tagged with `__scopeId`. The CSS itself is emitted by {@link compileVueStyles} (the Bun plugin wires
 * it into the client stylesheet); this function only handles the markup side.
 */
export function compileVue(source: string, filename: string, generate: "dom" | "ssr"): string {
  const ssr = generate === "ssr"
  const { descriptor, errors } = parse(source, { filename })
  if (errors.length > 0) {
    throw new Error(
      `[nifra/web-vue] failed to parse ${filename}: ${errors[0]?.message ?? "unknown"}`,
    )
  }
  const id = scopeId(filename)
  const scopeAttr = descriptor.styles.some((s) => s.scoped) ? `data-v-${id}` : undefined

  // compileScript merges `<script>` + `<script setup>`; `genDefaultAs` emits the component as
  // `const _sfc_main = …` (so the plain script's `export const loader/meta` stay module exports).
  let code: string
  let bindings: BindingMetadata | undefined
  if (descriptor.script !== null || descriptor.scriptSetup !== null) {
    const script = compileScript(descriptor, { id, inlineTemplate: false, genDefaultAs: COMPONENT })
    code = script.content
    bindings = script.bindings
  } else {
    // Template-only SFC: no script block → an empty component options object.
    code = `const ${COMPONENT} = {}\n`
  }

  if (descriptor.template !== null) {
    const template = compileTemplate({
      source: descriptor.template.content,
      filename,
      id,
      ssr,
      ssrCssVars: [], // nifra has no `v-bind()` CSS-var pipeline — empty silences the SSR warning
      compilerOptions: {
        ...(bindings !== undefined ? { bindingMetadata: bindings } : {}),
        ...(scopeAttr !== undefined ? { scopeId: scopeAttr } : {}), // bake `data-v-<id>` onto elements
      },
    })
    if (template.errors.length > 0) {
      throw new Error(
        `[nifra/web-vue] template error in ${filename}: ${templateErrorMessage(template.errors[0] as string | { message?: string })}`,
      )
    }
    // `render`/`ssrRender` come from the compiled template; bind whichever the renderer reads.
    code += `\n${template.code}\n${COMPONENT}.${ssr ? "ssrRender = ssrRender" : "render = render"}\n`
  }
  if (scopeAttr !== undefined) code += `${COMPONENT}.__scopeId = ${JSON.stringify(scopeAttr)}\n`

  return `${code}\nexport default ${COMPONENT}\n`
}

/**
 * Compile a `.vue` SFC's `<style>` blocks to a single CSS string (scoped selectors rewritten to
 * `[data-v-<id>]` when `scoped`). Returns `""` for a style-less SFC. The matching scope attribute is
 * baked into the markup by {@link compileVue}.
 */
export function compileVueStyles(source: string, filename: string): string {
  const { descriptor } = parse(source, { filename })
  if (descriptor.styles.length === 0) return ""
  const id = `data-v-${scopeId(filename)}`
  let css = ""
  for (const style of descriptor.styles) {
    const compiled = compileStyle({
      source: style.content,
      filename,
      id,
      scoped: style.scoped ?? false,
    })
    if (compiled.errors.length > 0) {
      throw new Error(
        `[nifra/web-vue] style error in ${filename}: ${compiled.errors[0]?.message ?? "unknown"}`,
      )
    }
    css += compiled.code
  }
  return css
}

/**
 * The `.vue` compiler Bun plugin. `"dom"` → client-hydratable output; `"ssr"` → server render. On the
 * `"dom"` build, a SFC's `<style>` CSS is emitted as a virtual `?vue-css` module that `Bun.build`'s CSS
 * bundler folds into the app stylesheet (served as a `<link>`). The `"ssr"` build emits no CSS — the
 * scope attributes are already in the markup and the stylesheet ships from the client build. With
 * `nifra dev`, `@vitejs/plugin-vue` handles the styles instead.
 */
export function vueBunPlugin(generate: "dom" | "ssr"): BunPlugin {
  const cssByPath = new Map<string, string>()
  return {
    name: `nifra-vue-${generate}`,
    setup(build) {
      // Match `.vue`, tolerating a `?query` suffix (dev servers append one to bust Bun's import cache).
      build.onLoad({ filter: /\.vue(\?|$)/ }, async (args) => {
        const path = args.path.split("?")[0] ?? args.path
        const source = await Bun.file(path).text()
        // `ts`, not `js`: `@vue/compiler-sfc` leaves TS syntax (a `lang="ts"` script's types) for the
        // bundler to strip. The `ts` loader handles both TS and plain-JS SFC output (TS ⊃ JS).
        const js = compileVue(source, path, generate)
        if (generate === "dom") {
          const css = compileVueStyles(source, path)
          if (css.length > 0) {
            cssByPath.set(path, css)
            return {
              contents: `${js}\nimport ${JSON.stringify(path + STYLE_SUFFIX)}\n`,
              loader: "ts",
            }
          }
        }
        return { contents: js, loader: "ts" }
      })
      // Virtual CSS module: `<file>.vue?vue-css` → the compiled (scoped) stylesheet (css loader).
      build.onResolve({ filter: /\?vue-css$/ }, (args) => ({
        path: args.path,
        namespace: STYLE_NS,
      }))
      build.onLoad({ filter: /.*/, namespace: STYLE_NS }, (args) => ({
        contents: cssByPath.get(args.path.slice(0, -STYLE_SUFFIX.length)) ?? "",
        loader: "css",
      }))
    },
  }
}
