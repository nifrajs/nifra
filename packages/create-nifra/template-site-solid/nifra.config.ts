// The nifra CLI's config — read by `nifra dev|build|start`. It's imported ONLY by the CLI (which runs on
// Bun), so it can eagerly import the Vite plugin + the Solid compile plugin — keeping them OUT of the
// edge worker bundle that `framework.ts` (the render-adapter source the entries import) must stay free
// of. Solid needs the `"solid"` resolve condition (routes solid-js to its source / JSX-dev build).
import { solidBunPlugin } from "@nifrajs/web-solid"
import solid from "vite-plugin-solid"

export { adapter } from "./framework"
export const clientModule = "@nifrajs/web-solid/client"
// `ssr: true` makes vite-plugin-solid emit hydratable client output, matching nifra's Bun SSR.
export const vitePlugins = [solid({ ssr: true })]
export const clientPlugins = [solidBunPlugin("dom")]
export const serverPlugins = [solidBunPlugin("ssr")]
export const conditions = ["solid"]
