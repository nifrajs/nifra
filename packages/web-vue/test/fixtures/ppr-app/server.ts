/**
 * The Vue twin of `web/test/fixtures/ppr/app`: the same routes, ids, texts and backend halves, as
 * single-file components, so `app-browser.ts` drives it unchanged under `FRAMEWORK=vue`.
 */
import { plugin } from "bun"
import {
  type PprApp,
  startPprApp as startFixture,
} from "../../../../web/test/fixtures/ppr/app/server.ts"
import { vueAdapter } from "../../../src/index.ts"
import { vueBunPlugin } from "../../../src/plugin.ts"

plugin(vueBunPlugin("ssr"))

export const trustedTypesPolicy: string | null = "vue"

export const startPprApp = (options?: Parameters<typeof startFixture>[1]): Promise<PprApp> =>
  startFixture(
    {
      routesDir: `${import.meta.dir}/routes`,
      adapter: vueAdapter,
      clientModule: "@nifrajs/web-vue/client",
      clientPlugins: [vueBunPlugin("dom")],
      serverPlugins: [vueBunPlugin("ssr")],
    },
    options,
  )
