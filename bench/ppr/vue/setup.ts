import { vueBunPlugin } from "@nifrajs/web-vue/plugin"

export { vueAdapter as adapter } from "@nifrajs/web-vue"
export const serverPlugins = [vueBunPlugin("ssr")]
