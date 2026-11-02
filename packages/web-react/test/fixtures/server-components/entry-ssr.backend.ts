import { createWebApp } from "@nifrajs/web"
import { serverFunctions } from "@nifrajs/web/fn"
import {
  createServerComponents,
  serverComponentIdentity,
  serverComponentInstance,
} from "@nifrajs/web/server-components"
import { componentBuild } from "@nifrajs/web/server-components/build-info"
import { reactServerComponents } from "@nifrajs/web-react/server-components"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { componentBenchmark } from "../../../../web/test/fixtures/server-components/benchmark.backend"
import { save } from "./actions.fn"
import { Child } from "./Child.component.server"
import Page from "./frontend/Page"
import { Summary } from "./Summary.component.server"
export async function createApp(
  clientEntry = "/entry.client.ts",
  assets: { styles?: readonly string[]; assets?: readonly string[] } = {},
) {
  const rsc = await import.meta.viteRsc.loadModule<typeof import("./entry-rsc.backend")>(
    "rsc",
    "index",
  )
  const components = createServerComponents({
    build: componentBuild,
    assets: assets.assets ?? [],
    adapter: reactServerComponents(rsc.render),
    owners: {
      product: {
        components: [Summary, Child],
        scope: (ctx) =>
          ctx.request.headers.get("cookie")?.includes("fixture-subject=B") ? "scope_B" : "scope_A",
        instances: async (ctx) => [
          serverComponentInstance(Summary, "summary", {}),
          ...(ctx.search.remove === "yes"
            ? []
            : [
                serverComponentInstance(
                  Child,
                  "detail",
                  {},
                  await serverComponentIdentity("product", Summary, "summary"),
                ),
              ]),
        ],
      },
    },
  })
  const manifest = {
    routes: [
      {
        id: "product",
        pattern: "/",
        layoutIds: [],
        errorIds: [],
        file: "fixture.ts",
        load: async () => ({
          default: () => null,
          action: async (ctx: import("@nifrajs/web").LoaderContext) => {
            const form = await ctx.request.formData()
            if (form.get("fail") === "yes") throw new Response(null, { status: 422 })
            ctx.set.cookie("fixture-revision", "3", { path: "/", sameSite: "lax", secure: false })
            return { saved: true }
          },
          loader: async (ctx: import("@nifrajs/web").LoaderContext) => {
            if (ctx.search.deny === "yes") throw new Response(null, { status: 403 })
            if (ctx.search.delay === "slow")
              await new Promise((resolve) => setTimeout(resolve, 250))
            return {
              title: ctx.request.headers.get("cookie")?.includes("fixture-subject=B")
                ? "B title"
                : "Public title",
              revision:
                ctx.search.delay === "flight"
                  ? 4
                  : ctx.search.revision === "new"
                    ? 2
                    : ctx.search.revision === "latest"
                      ? 3
                      : ctx.request.headers.get("cookie")?.includes("fixture-revision=3")
                        ? 3
                        : ctx.request.headers.get("cookie")?.includes("fixture-revision=2")
                          ? 2
                          : 1,
              islandKey: ctx.search.rekey === "yes" ? 1 : 0,
            }
          },
        }),
      },
    ],
    layouts: {},
    errors: {},
  }
  return createWebApp({
    nonce: () => "fixture_nonce",
    use(app) {
      app.use(serverFunctions("actions", { save }))
      app.beforeHandle((ctx) => {
        if (new URL(ctx.req.url).searchParams.get("csp") === "yes")
          ctx.set.headers["content-security-policy"] =
            "default-src 'self'; script-src 'nonce-fixture_nonce' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'" +
            (new URL(ctx.req.url).searchParams.get("tt") === "yes"
              ? "; require-trusted-types-for 'script'; trusted-types default vue"
              : "")
      })
    },
    manifest,
    styles: assets.styles ?? [],
    serverComponents: components,
    clientEntry,
    llmsTxt: false,
    adapter: {
      hydrationHead: () => "",
      renderToString(_chain, props) {
        const state = props.serverComponents!
        return (
          '<form id="progressive" method="post" action="/"><button id="progressive-save">Save</button></form><nav><a id="nav-next" href="/?revision=new">Next</a><a id="nav-latest" href="/?revision=latest">Latest</a></nav><div id="fixture-parent">' +
          renderToString(createElement(Page, { state })) +
          '</div><script id="component-state" type="application/json">' +
          JSON.stringify(state).replaceAll("<", "\\u003c") +
          "</script>"
        )
      },
      renderToStream() {
        throw new Error("fixture uses buffered SSR")
      },
    },
  })
}
let app: Awaited<ReturnType<typeof createApp>> | undefined
export async function createBenchmark(assets: readonly string[] = []) {
  const rsc = await import.meta.viteRsc.loadModule<typeof import("./entry-rsc.backend")>(
    "rsc",
    "index",
  )
  const adapter = reactServerComponents(rsc.render)
  const runtime = createServerComponents({
    build: componentBuild,
    assets,
    adapter,
    owners: {
      product: {
        components: [Summary, Child],
        scope: "anonymous",
        instances: async () => [
          serverComponentInstance(Summary, "summary", {}),
          serverComponentInstance(
            Child,
            "detail",
            {},
            await serverComponentIdentity("product", Summary, "summary"),
          ),
        ],
      },
    },
  })
  return componentBenchmark(runtime, adapter, Summary, Child, componentBuild)
}
export default async function handler(request: Request) {
  app ??= await createApp()
  return app.fetch(request)
}
