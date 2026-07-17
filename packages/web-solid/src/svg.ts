/**
 * `@nifrajs/web-solid/svg` - the Solid build of the SVG-as-component plugin. `import Icon from
 * "./icon.svg?component"`, then `<Icon class="w-6 h-6" />`, props spread onto the root `<svg>`.
 *
 * Solid JSX is not standard JSX (it compiles through `babel-preset-solid`) and uses `class`, not
 * `className` - so this can't reuse the React/Preact plugin from `@nifrajs/web/plugins/svg`. It shares
 * that package's `svgToJsx` transform (with `classProp: "class"`) to produce a Solid component, then
 * runs the same Solid + TypeScript babel passes `solidBunPlugin` applies to `.tsx`. Pass `"dom"` for the
 * client bundle and preload `"ssr"` for the server.
 */
import { transformAsync } from "@babel/core"
// @ts-expect-error - no type declarations published
import presetTypeScript from "@babel/preset-typescript"
import { SVG_COMPONENT_FILTER, svgComponentSource } from "@nifrajs/web/plugins/svg"
// @ts-expect-error - no type declarations published
import presetSolid from "babel-preset-solid"
import type { BunPlugin } from "bun"

/** The Solid SVG-component plugin. `generate` selects the Solid `"dom"`/`"ssr"` output, matching
 * `solidBunPlugin`. A plain `import "./icon.svg"` (asset URL) is untouched - only `?component` matches. */
export function solidSvgComponentBunPlugin(generate: "dom" | "ssr"): BunPlugin {
  return {
    name: `nifra-solid-svg-${generate}`,
    setup(build) {
      build.onLoad({ filter: SVG_COMPONENT_FILTER }, async (args) => {
        const path = args.path.split("?")[0] ?? args.path
        const xml = await Bun.file(path).text()
        // Solid uses `class`; emit the component JSX, then run the Solid + TS babel passes.
        const source = svgComponentSource(xml, { classProp: "class" })
        const result = await transformAsync(source, {
          filename: `${path}.tsx`, // ensure presetTypeScript treats it as TSX-eligible
          presets: [
            [presetSolid, { generate, hydratable: true }],
            [presetTypeScript, { onlyRemoveTypeImports: true }],
          ],
        })
        return { contents: result?.code ?? "", loader: "js" }
      })
    },
  }
}
