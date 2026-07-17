/**
 * `@nifrajs/web-svelte/svg` - the Svelte build of the SVG-as-component plugin. `import Icon from
 * "./icon.svg?component"`, then `<Icon class="w-6 h-6" />`, props spread onto the root `<svg>`.
 *
 * Svelte markup accepts SVG almost verbatim (`class`, hyphenated attributes, an inline `style` string
 * all work as-is), so - unlike the JSX adapters - no attribute rewriting is needed: the raw SVG is
 * wrapped in a Svelte 5 component that spreads its props onto the root element, then compiled with the
 * project's `svelte` compiler. Pass `"dom"` for the client bundle and preload `"ssr"` for the server;
 * a plain `import "./icon.svg"` (asset URL) is untouched - only `?component` matches.
 */
import { SVG_COMPONENT_FILTER } from "@nifrajs/web/plugins/svg"
import type { BunPlugin } from "bun"
import { compile } from "svelte/compiler"

/** Wrap raw SVG XML in a Svelte 5 component: strip XML noise, spread props onto the root `<svg>`. */
export function svgToSvelte(xml: string): string {
  const cleaned = xml
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .trim()
  // `$props()` opts the component into runes (Svelte 5); spread onto the root so user attrs win.
  const withSpread = cleaned.replace(/^(<svg\b[^>]*?)>/, "$1 {...props}>")
  return `<script>const props = $props()</script>\n${withSpread}\n`
}

/** The Svelte SVG-component plugin. `generate` selects Svelte's `"client"`/`"server"` output, matching
 * `svelteBunPlugin`. */
export function svelteSvgComponentBunPlugin(generate: "dom" | "ssr"): BunPlugin {
  return {
    name: `nifra-svelte-svg-${generate}`,
    setup(build) {
      build.onLoad({ filter: SVG_COMPONENT_FILTER }, async (args) => {
        const path = args.path.split("?")[0] ?? args.path
        const xml = await Bun.file(path).text()
        const { js } = compile(svgToSvelte(xml), {
          generate: generate === "ssr" ? "server" : "client",
          filename: path,
        })
        return { contents: js.code, loader: "js" }
      })
    },
  }
}
