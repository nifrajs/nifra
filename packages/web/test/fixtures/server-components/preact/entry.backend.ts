import type { Manifest } from "@nifrajs/web"
import { createWebApp } from "@nifrajs/web"
import { serverFunctions } from "@nifrajs/web/fn"
import {
  createServerComponents,
  serverComponentIdentity,
  serverComponentInstance,
} from "@nifrajs/web/server-components"
import { componentBuild } from "@nifrajs/web/server-components/build-info"
import { h } from "preact"
import { renderToString } from "preact-render-to-string"
import { componentBenchmark } from "../benchmark.backend"
import { save } from "./actions.fn"
import { hydrationHead, serverAdapter } from "./adapter.backend"
import { Child } from "./Child.component.server"
import Page from "./Page.frontend.tsx"
import { Summary } from "./Summary.component.server"

const summary = createServerComponents({
  build: componentBuild,
  adapter: serverAdapter(),
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
const manifest: Manifest = {
  routes: [
    {
      id: "product",
      pattern: "/",
      layoutIds: [],
      errorIds: [],
      file: "fixture.ts",
      load: async () => ({
        default: () => null,
        action: async (ctx) => {
          const form = await ctx.request.formData()
          if (form.get("fail") === "yes") throw new Response(null, { status: 422 })
          ctx.set.cookie("fixture-revision", "3", { path: "/", sameSite: "lax", secure: false })
          return { saved: true }
        },
        loader: async (ctx) => {
          if (ctx.search.deny === "yes") throw new Response(null, { status: 403 })
          if (ctx.search.delay === "slow") await new Promise((resolve) => setTimeout(resolve, 250))
          return {
            title: ctx.request.headers.get("cookie")?.includes("fixture-subject=B")
              ? "B title"
              : "Public title",
            revision:
              ctx.search.revision === "new"
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
export function createBenchmark() {
  return componentBenchmark(summary, serverAdapter(), Summary, Child, componentBuild)
}
export function createApp(
  clientEntry = "/entry.client.ts",
  assets: { styles?: readonly string[] } = {},
) {
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
    serverComponents: summary,
    clientEntry,
    llmsTxt: false,
    adapter: {
      hydrationHead,
      async renderToString(_chain, props) {
        const state = props.serverComponents!
        return (
          '<form id="progressive" method="post" action="/"><button id="progressive-save">Save</button></form><nav><a id="nav-next" href="/?revision=new">Next</a><a id="nav-latest" href="/?revision=latest">Latest</a></nav><div id="fixture-parent">' +
          renderToString(h(Page, { state })) +
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
export default createApp()
