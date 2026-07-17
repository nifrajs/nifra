/**
 * `@nifrajs/web-vue/svg` - the Vue build of the SVG-as-component plugin. `import Icon from
 * "./icon.svg?component"`, then `<Icon class="w-6 h-6" />`, props spread onto the root `<svg>`.
 *
 * Vue templates accept SVG almost verbatim (`class`, hyphenated attributes, an inline `style` string),
 * and a single-root component auto-inherits `$attrs` onto that root - so the raw SVG becomes a Vue
 * template with no attribute rewriting, and the caller's `class`/`width`/… land on the `<svg>` for free.
 * The SFC is compiled through the same `compileVue` pass the `.vue` plugin uses (`@vue/compiler-sfc`
 * peer). Pass `"dom"` for the client bundle, preload `"ssr"` for the server; a plain
 * `import "./icon.svg"` (asset URL) is untouched - only `?component` matches.
 */
import { SVG_COMPONENT_FILTER } from "@nifrajs/web/plugins/svg"
import type { BunPlugin } from "bun"
import { compileVue } from "./plugin.ts"

/** Wrap raw SVG XML in a template-only Vue SFC (single root → Vue inherits attrs onto the `<svg>`). */
export function svgToVueSfc(xml: string): string {
  const cleaned = xml
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .trim()
  // An (empty) <script> is required by compileScript; the single-root <svg> inherits caller attrs.
  return `<script>export default {}</script>\n<template>${cleaned}</template>\n`
}

/** The Vue SVG-component plugin. `generate` selects Vue's client/SSR render, matching `vueBunPlugin`. */
export function vueSvgComponentBunPlugin(generate: "dom" | "ssr"): BunPlugin {
  return {
    name: `nifra-vue-svg-${generate}`,
    setup(build) {
      build.onLoad({ filter: SVG_COMPONENT_FILTER }, async (args) => {
        const path = args.path.split("?")[0] ?? args.path
        const xml = await Bun.file(path).text()
        return { contents: compileVue(svgToVueSfc(xml), `${path}.vue`, generate), loader: "js" }
      })
    },
  }
}
