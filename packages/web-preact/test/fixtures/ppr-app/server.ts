/**
 * The Preact twin of `web/test/fixtures/ppr/app`: the same routes, ids, texts and backend halves, so
 * `app-browser.ts` drives it unchanged under `FRAMEWORK=preact`.
 */
import {
  type PprApp,
  startPprApp as startFixture,
} from "../../../../web/test/fixtures/ppr/app/server.ts"
import { preactAdapter } from "../../../src/index.ts"

/** Preact's client creates no policy. */
export const trustedTypesPolicy: string | null = ""

export const startPprApp = (options?: Parameters<typeof startFixture>[1]): Promise<PprApp> =>
  startFixture(
    {
      routesDir: `${import.meta.dir}/routes`,
      adapter: preactAdapter,
      clientModule: "@nifrajs/web-preact/client",
      clientPlugins: [],
      serverPlugins: [],
    },
    options,
  )
