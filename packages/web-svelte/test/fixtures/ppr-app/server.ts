/**
 * The Svelte twin of `web/test/fixtures/ppr/app`: the same routes, ids, texts and backend halves, so
 * `app-browser.ts` drives it unchanged under `FRAMEWORK=svelte`.
 */
import { plugin } from "bun"
import {
  type PprApp,
  startPprApp as startFixture,
} from "../../../../web/test/fixtures/ppr/app/server.ts"
import { svelteAdapter } from "../../../src/index.ts"
import { svelteBunPlugin } from "../../../src/plugin.ts"

plugin(svelteBunPlugin("ssr"))

export const trustedTypesPolicy: string | null = "svelte-trusted-html"

export const startPprApp = (
  options?: Parameters<typeof startFixture>[1],
  routesDir = `${import.meta.dir}/routes`,
): Promise<PprApp> =>
  startFixture(
    {
      routesDir,
      adapter: svelteAdapter,
      clientModule: "@nifrajs/web-svelte/client",
      clientPlugins: [svelteBunPlugin("dom")],
      serverPlugins: [svelteBunPlugin("ssr")],
    },
    options,
  )
