/**
 * The Solid twin of `web/test/fixtures/ppr/app`: the same routes, ids, texts and backend halves, so
 * `app-browser.ts` drives it unchanged under `FRAMEWORK=solid`.
 */
import { plugin } from "bun"
import {
  type PprApp,
  startPprApp as startFixture,
} from "../../../../web/test/fixtures/ppr/app/server.ts"
import { solidAdapter } from "../../../src/index.ts"
import { solidBunPlugin } from "../../../src/plugin.ts"

plugin(solidBunPlugin("ssr"))

/** Solid's compiled templates write plain strings to `innerHTML`, under no policy. */
export const trustedTypesPolicy: string | null = null

export const startPprApp = (options?: Parameters<typeof startFixture>[1]): Promise<PprApp> =>
  startFixture(
    {
      routesDir: `${import.meta.dir}/routes`,
      adapter: solidAdapter,
      clientModule: "@nifrajs/web-solid/client",
      clientPlugins: [solidBunPlugin("dom")],
      serverPlugins: [solidBunPlugin("ssr")],
    },
    options,
  )
