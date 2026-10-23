import { solidBunPlugin } from "@nifrajs/web-solid/plugin"

export { solidAdapter as adapter } from "@nifrajs/web-solid"
export const serverPlugins = [solidBunPlugin("ssr")]
