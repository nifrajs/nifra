// The nifra CLI's config — read by `nifra dev|build|start`. It's imported ONLY by the CLI (which runs on
// Bun), so it can eagerly import the Vite plugin + the Svelte compiler — keeping them OUT of the edge
// worker bundle that `framework.ts` (the render-adapter source the entries import) must stay free of.
import { svelte } from "@sveltejs/vite-plugin-svelte"
import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"

export { adapter } from "./framework"
export const clientModule = "@nifrajs/web-svelte/client"
// `nifra dev` HMR: Vite + the official Svelte plugin compile/HMR the .svelte client modules.
export const vitePlugins = [svelte()]
// `nifra build` (client) + `nifra start`/`nifra dev` (Bun-side SSR) compile .svelte via these.
export const clientPlugins = [svelteBunPlugin("dom")]
export const serverPlugins = [svelteBunPlugin("ssr")]
