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

import { normalizeFilePath } from "@nifrajs/web/plugins/kit"
import { SVG_COMPONENT_FILTER, svgTemplateMarkup } from "@nifrajs/web/plugins/svg"
import type { BunPlugin } from "bun"
import { compile } from "svelte/compiler"

/** A brace as a character reference: in Svelte markup, text or an attribute value, it opens an expression. */
const braces = (text: string): string => text.replace(/[{}]/g, (char) => `&#${char.charCodeAt(0)};`)

/** Names Svelte reads as directives or special elements, never as SVG. */
const SVELTE_DIRECTIVE = /^(?:on|bind|use|class|style|transition|in|out|animate|let|attach):/

/** Wrap raw SVG XML in a Svelte 5 component: strip XML noise, spread props onto the root `<svg>`. */
export function svgToSvelte(xml: string): string {
  const cleaned = svgTemplateMarkup(xml, {
    text: (text, cdata) =>
      braces(cdata ? text.replaceAll("&", "&amp;").replaceAll("<", "&lt;") : text),
    attributeValue: braces,
    // A nested <style> or <script> is raw text to Svelte, so its braces are not expressions.
    rawText: new Set(["style", "script"]),
    refuse: (name, kind) =>
      kind === "attribute"
        ? SVELTE_DIRECTIVE.test(name)
          ? `the attribute ${name} is a Svelte directive`
          : undefined
        : name.startsWith("svelte:") || name.includes(".") || /^[A-Z]/.test(name)
          ? `Svelte reads the element <${name}> as a component or special element`
          : undefined,
  })
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
        const path = normalizeFilePath(args.path)
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
