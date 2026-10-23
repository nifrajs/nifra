import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"

export { svelteAdapter as adapter } from "@nifrajs/web-svelte"
export const serverPlugins = [svelteBunPlugin("ssr")]
