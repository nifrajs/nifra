import { expect, spyOn, test } from "bun:test"
import { t } from "@nifrajs/schema"
import ts from "typescript"
import {
  buildManifest,
  createWebApp,
  generateClientEntry,
  generateServerManifest,
  type RenderAdapter,
  type RenderStreamOptions,
  type RouteModule,
} from "../src/index.ts"
import { partialPrerendering } from "../src/ppr.ts"

const importer = (file: string) => async (): Promise<RouteModule> => ({ default: file })
const FILES = ["_layout.tsx", "index.tsx", "list.tsx", "shop/_layout.tsx", "shop/[item].tsx"]
const kept = () => buildManifest(FILES, importer, { keepAlive: ["list.tsx", "shop/[item].tsx"] })
const resolve = (file: string) => `/routes/${file}`
const TOKENS = ["keep-alive", "keepAlive", "__keep", "dropKept"]

test("an app without keepAlive generates no keep-alive code", () => {
  const code = generateClientEntry(buildManifest(FILES, importer), {
    clientModule: "@nifrajs/web-react/client",
    resolve,
  })
  for (const token of TOKENS) expect(code).not.toContain(token)
  const server = generateServerManifest(buildManifest(FILES, importer), {
    resolve,
    clientEntry: "",
  })
  expect(server).not.toContain("keepAlive")
})

test("a keepAlive app mounts through the adapter's keep-alive module, over the keep-alive router", () => {
  for (const adapter of ["web-react", "web-svelte"]) {
    const code = generateClientEntry(kept(), {
      clientModule: `@nifrajs/${adapter}/client`,
      resolve,
    })
    expect(code).toContain(`import * as __adapter from "@nifrajs/${adapter}/keep-alive"`)
    expect(code).toContain('import { keepAliveClient } from "@nifrajs/web/keep-alive"')
    expect(code).toContain(
      'const keepAliveTable = {"routes":["list","shop/[item]"],"layouts":["shop/_layout"]}',
    )
    expect(code).toContain(
      "const __keep = keepAliveClient({ table: keepAliveTable, routeHooks, matchChains })",
    )
    expect(code).toContain("const router = __keep.attach(")
    expect(code).toContain(", fetchData: __keep.fetchData")
    expect(code).toContain("keepAlive: page.keepAlive")
    expect(code).toContain('router.dropKept("hot-update")')
    expect(code).toContain("keepAlive: keepAliveTable")
    expect(ts.transpileModule(code, { reportDiagnostics: true }).diagnostics ?? []).toEqual([])
  }
})

test("a live keepAlive app layers keep-alive over the live transport", () => {
  const code = generateClientEntry(kept(), {
    clientModule: "@nifrajs/web-react/client",
    resolve,
    live: { path: "/rt", loadPath: "/rt/load" },
  })
  expect(code).toContain(
    "const __keep = keepAliveClient({ table: keepAliveTable, routeHooks, matchChains, fetchData: __live.fetchData })",
  )
  expect(code).toContain("routeHooks, fetchData: __keep.fetchData }))")
})

test("an adapter without keep-alive support fails the build and names the routes", () => {
  expect(() =>
    generateClientEntry(kept(), { clientModule: "@nifrajs/web-vanilla/client", resolve }),
  ).toThrow(
    /"list", "shop\/\[item\]" export keepAlive, which needs the React, Preact, Solid, Svelte or Vue adapter; .* "@nifrajs\/web-vanilla\/client"/,
  )
})

test("the server manifest carries which route files keep alive, lazy or eager", () => {
  for (const lazy of [false, true]) {
    const code = generateServerManifest(kept(), { resolve, clientEntry: "", lazy })
    expect(code).toContain(', { keepAlive: ["list.tsx","shop/[item].tsx"] })')
  }
})

// ---- the server renders each wrapped depth ------------------------------------------------------

const recordingAdapter = (
  mode: "string" | "stream",
  options: { readonly documentParts?: boolean; readonly after?: string } = {},
): RenderAdapter & { readonly seen: (RenderStreamOptions | undefined)[] } => {
  const seen: (RenderStreamOptions | undefined)[] = []
  const html = (streamOptions: RenderStreamOptions | undefined) => {
    seen.push(streamOptions)
    return `<p>slots ${JSON.stringify(streamOptions?.slots ?? null)}</p>${options.after ?? ""}`
  }
  const adapter: RenderAdapter & { readonly seen: (RenderStreamOptions | undefined)[] } = {
    seen,
    hydrationHead: () => "",
    documentParts: options.documentParts === true,
    renderToStream: async (_chain, _props, streamOptions) =>
      new Blob([html(streamOptions)]).stream(),
  }
  return mode === "string"
    ? { ...adapter, renderToString: (_chain, _props, streamOptions) => html(streamOptions) }
    : adapter
}

const backendHalf: Pick<RouteModule, "action" | "actionOutput"> = {
  action: () => ({ ok: true }),
  actionOutput: t.object({ ok: t.boolean() }),
}
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a backend half has no `default` export, and the importer type names the merged module
const backend = backendHalf as RouteModule

const serverManifest = () =>
  buildManifest(
    [
      "_layout.tsx",
      "index.tsx",
      "list.tsx",
      "list.backend.ts",
      "shop/_layout.tsx",
      "shop/[item].tsx",
      "_404.tsx",
    ],
    (file) => async () => (file.endsWith(".backend.ts") ? backend : { default: () => null }),
    { keepAlive: ["list.tsx", "shop/[item].tsx"] },
  )

test("a keepAlive app's server render passes the wrapped depths, on every render path", async () => {
  for (const mode of ["string", "stream"] as const) {
    for (const nonce of [undefined, () => "n0nce"]) {
      for (const documentParts of [false, true]) {
        const adapter = recordingAdapter(mode, { documentParts })
        const base = { adapter, manifest: serverManifest(), clientEntry: "/c.js" }
        const app = createWebApp(nonce === undefined ? base : { ...base, nonce })
        const shop = await (await app.fetch(new Request("http://x/shop/a"))).text()
        expect(shop).toContain("<p>slots [1,2]</p>")
        const list = await (await app.fetch(new Request("http://x/list"))).text()
        expect(list).toContain("<p>slots [1]</p>")
        // A page that does not keep alive, under a layout every chain shares: no wrappers.
        expect(await (await app.fetch(new Request("http://x/"))).text()).toContain(
          "<p>slots []</p>",
        )
        const posted = await app.fetch(
          new Request("http://x/list", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://x" },
            body: "a=1",
          }),
        )
        expect(await posted.text()).toContain("<p>slots [1]</p>")
        const missing = await app.fetch(new Request("http://x/nowhere"))
        expect(missing.status).toBe(404)
        expect(await missing.text()).toContain("<p>slots []</p>")
        const last = adapter.seen.at(-1)
        expect(last?.nonce === undefined).toBe(nonce === undefined)
        expect(last?.parts === undefined).toBe(!documentParts)
      }
    }
  }
})

const shellHalf: Pick<RouteModule, "shellLoader" | "shellOutput" | "boundaryLoaders"> = {
  shellLoader: () => ({ title: "list" }),
  shellOutput: t.object({ title: t.string() }),
  boundaryLoaders: { note: { load: () => ({}), output: t.object({}) } },
}
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a backend half has no `default` export, and the importer type names the merged module
const shellBackend = shellHalf as RouteModule

test("a kept page's partially prerendered shell carries the wrappers its document hydrates with", async () => {
  // No build checked the shell here, which the app warns about.
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    for (const mode of ["string", "stream"] as const) {
      const adapter = {
        ...recordingAdapter(mode, { after: '<div data-nifra-hole="note" aria-busy="true"></div>' }),
        renderFragment: () => "",
      }
      const manifest = buildManifest(
        ["_layout.tsx", "list.tsx", "list.backend.ts"],
        (file) => async () =>
          file === "list.backend.ts"
            ? shellBackend
            : file === "list.tsx"
              ? {
                  default: () => null,
                  boundaries: [{ name: "note", mode: "dynamic", render: () => "n" }],
                }
              : { default: () => null },
        { keepAlive: ["list.tsx"] },
      )
      const app = createWebApp({
        adapter,
        manifest,
        clientEntry: "/c.js",
        ppr: partialPrerendering({ shellChecks: "unchecked-development" }),
      })
      const shell = await (await app.fetch(new Request("http://x/list"))).text()
      expect(shell).toContain("nifra-ppr-req")
      expect(shell).toContain("<p>slots [1]</p>")
    }
  } finally {
    warn.mockRestore()
  }
})
