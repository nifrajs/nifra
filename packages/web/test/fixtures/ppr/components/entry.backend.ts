import { buildManifest, createCspPolicy, createWebApp, type RouteModule } from "@nifrajs/web"
import { partialPrerendering } from "@nifrajs/web/ppr"
import { createServerComponents } from "@nifrajs/web/server-components"
import { componentBuild } from "@nifrajs/web/server-components/build-info"
import { vueAdapter } from "@nifrajs/web-vue"
import { vueServerComponents } from "@nifrajs/web-vue/server-components"
import { Summary } from "./Summary.component.server.ts"

const routes = import.meta.glob<RouteModule>("./routes/**/*.{ts,tsx}")
const manifest = buildManifest(
  Object.keys(routes).map((file) => file.slice("./routes/".length)),
  (file) => {
    const load = routes[`./routes/${file}`]
    if (load === undefined) throw new Error(`no route module ${file}`)
    return load
  },
)

type ShellChecks = Parameters<typeof partialPrerendering>[0]["shellChecks"]

/** `shellChecks`: what `compileShells` returns for this build, as a deployment passes it. */
export function createApp(
  clientEntry: string,
  assets: { readonly styles?: readonly string[] },
  shellChecks: ShellChecks,
) {
  return createWebApp({
    adapter: vueAdapter,
    manifest,
    clientEntry,
    styles: assets.styles ?? [],
    llmsTxt: false,
    csp: createCspPolicy({
      header: ({ sources }) =>
        `default-src 'self'; script-src 'self' ${sources}; style-src 'self'; object-src 'none'; base-uri 'none'`,
    }),
    serverComponents: createServerComponents({
      build: componentBuild,
      adapter: vueServerComponents(),
      owners: {},
      holes: { "p/[id]": { components: [Summary] } },
    }),
    ppr: partialPrerendering({ shellChecks }),
  })
}
