// The nifra CLI's config - read by `nifra dev|build|start`. It's imported ONLY by the CLI (which runs on
// Bun), so it can eagerly import the Vite plugin + the Solid compile plugin - keeping them OUT of the
// edge worker bundle that `backend/framework.ts` (the render-adapter source the generated server entry
// imports) must stay free of.
import { solidBunPlugin } from "@nifrajs/web-solid/plugin"
import solid from "@solidjs/vite-plugin"

export { adapter } from "./backend/framework"
export const clientModule = "@nifrajs/web-solid/client"
// `ssr: true` makes @solidjs/vite-plugin emit hydratable client output, matching nifra's Bun SSR.
export const vitePlugins = [solid({ ssr: true })]
export const clientPlugins = [solidBunPlugin("dom")]
export const serverPlugins = [solidBunPlugin("ssr")]
