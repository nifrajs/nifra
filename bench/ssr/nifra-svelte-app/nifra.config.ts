import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"

export { adapter } from "./backend/framework"
export const clientModule = "@nifrajs/web-svelte/client"
export const clientPlugins = [svelteBunPlugin("dom")]
export const serverPlugins = [svelteBunPlugin("ssr")]
