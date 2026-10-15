import { solidBunPlugin } from "@nifrajs/web-solid/plugin"

export { adapter } from "./backend/framework"
export const clientModule = "@nifrajs/web-solid/client"
export const clientPlugins = [solidBunPlugin("dom")]
export const serverPlugins = [solidBunPlugin("ssr")]
export const conditions = ["solid"]
