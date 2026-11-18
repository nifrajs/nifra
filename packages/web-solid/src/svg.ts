/**
 * `@nifrajs/web-solid/svg` - the Solid build of the SVG-as-component plugin. `import Icon from
 * "./icon.svg?component"`, then `<Icon class="w-6 h-6" />`, props spread onto the root `<svg>`.
 *
 * Solid JSX is not standard JSX (it compiles through `@solidjs/compiler`) and uses `class`, not
 * `className` - so this can't reuse the React/Preact plugin from `@nifrajs/web/plugins/svg`. It shares
 * that package's `svgToJsx` transform (with `classProp: "class"`) to produce a Solid component, then
 * runs the same compile `solidBunPlugin` applies to `.tsx`. Pass `"dom"` for the client bundle and
 * preload `"ssr"` for the server.
 */
import { normalizeFilePath } from "@nifrajs/web/plugins/kit"
import { SVG_COMPONENT_FILTER, svgComponentSource } from "@nifrajs/web/plugins/svg"
import { transformAsync } from "@solidjs/compiler"
import type { BunPlugin } from "bun"

/** The Solid SVG-component plugin. `generate` selects the Solid `"dom"`/`"ssr"` output, matching
 * `solidBunPlugin`. A plain `import "./icon.svg"` (asset URL) is untouched - only `?component` matches. */
export function solidSvgComponentBunPlugin(generate: "dom" | "ssr"): BunPlugin {
  return {
    name: `nifra-solid-svg-${generate}`,
    setup(build) {
      build.onLoad({ filter: SVG_COMPONENT_FILTER }, async (args) => {
        const path = normalizeFilePath(args.path)
        const xml = await Bun.file(path).text()
        // Solid uses `class`; emit the component JSX, then compile it. The `.tsx` name picks the TSX dialect.
        const source = svgComponentSource(xml, { classProp: "class" })
        const result = await transformAsync(source, {
          filename: `${path}.tsx`,
          generate,
          hydratable: true,
        })
        return { contents: result.code, loader: "ts" }
      })
    },
  }
}
