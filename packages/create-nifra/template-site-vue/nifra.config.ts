// The nifra CLI's config — read by `nifra dev|build|start`. It's imported ONLY by the CLI (which runs on
// Bun), so it can eagerly import the Vite plugin + the SFC compiler — keeping them OUT of the edge
// worker bundle that `framework.ts` (the render-adapter source the entries import) must stay free of.
import { vueBunPlugin } from "@nifrajs/web-vue/plugin"
import vue from "@vitejs/plugin-vue"

export { adapter } from "./framework"
export const clientModule = "@nifrajs/web-vue/client"
// `nifra dev` HMR: Vite + the official Vue plugin compile/HMR the .vue client modules.
export const vitePlugins = [vue()]
// `nifra build` (client) + `nifra start`/`nifra dev` (Bun-side SSR) compile .vue via these.
export const clientPlugins = [vueBunPlugin("dom")]
export const serverPlugins = [vueBunPlugin("ssr")]
// Vue feature flags the plugin doesn't inject (mirrors the build scripts' define).
export const define = {
  __VUE_OPTIONS_API__: "true",
  __VUE_PROD_DEVTOOLS__: "false",
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
}
