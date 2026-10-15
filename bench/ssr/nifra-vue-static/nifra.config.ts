import { vueBunPlugin } from "@nifrajs/web-vue/plugin"

export { adapter } from "./backend/framework"
export const clientModule = "@nifrajs/web-vue/client"
export const clientPlugins = [vueBunPlugin("dom")]
export const serverPlugins = [vueBunPlugin("ssr")]
export const define = {
  __VUE_OPTIONS_API__: "true",
  __VUE_PROD_DEVTOOLS__: "false",
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
}
