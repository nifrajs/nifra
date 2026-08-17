import { expect, test } from "bun:test"
import { buildManifest, createWebApp, type RenderAdapter, type RouteModule } from "../src/index.ts"

const streamOf = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })

const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(`<p>chain=${chain.length}:${JSON.stringify(props.data)}</p>`),
  hydrationHead: () => "",
}

test("generateServerManifest's runtime pattern round-trips through createWebApp (no fs)", async () => {
  // The exact expression generateServerManifest emits - exercised with in-memory route modules
  // (the bundled worker's `import * as` namespaces) to prove createWebApp SSRs from it, unchanged.
  const modules: Record<string, RouteModule> = {
    "_layout.tsx": { default: "layout" },
    "index.tsx": { default: "home", loader: () => ({ hello: "edge" }) },
    "users/[id].tsx": { default: "user", loader: (ctx) => ({ id: ctx.params.id }) },
    "_404.tsx": { default: "not-found" },
  }
  const manifest = buildManifest(
    Object.keys(modules),
    (file) => () => Promise.resolve(modules[file] as RouteModule),
  )
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  // index: loader ran, wrapped in the root _layout (chain 2 = [layout, page]) - buildManifest applies
  // the root layout to every route, proving the layout-chain derivation survives the codegen pattern.
  expect(await (await app.fetch(new Request("http://x/"))).text()).toContain(
    'chain=2:{"hello":"edge"}',
  )
  // users/:id: same root layout chain + a params-driven loader.
  expect(await (await app.fetch(new Request("http://x/users/42"))).text()).toContain(
    'chain=2:{"id":"42"}',
  )
  // unmatched → _404 (status 404).
  expect((await app.fetch(new Request("http://x/nope"))).status).toBe(404)
})

test("the lazy runtime pattern round-trips through createWebApp (loaders called on demand)", async () => {
  // Mirror lazy codegen: a per-file loader map (here `() => Promise.resolve(mod)` stands in for
  // `() => import(...)`), behind the same `(file) => () => loaders[file]()` importer the codegen emits.
  const loaded: string[] = []
  const make = (mod: RouteModule) => () => {
    loaded.push((mod.default as string) ?? "?")
    return Promise.resolve(mod)
  }
  const loaders: Record<string, () => Promise<RouteModule>> = {
    "_layout.tsx": make({ default: "layout" }),
    "index.tsx": make({ default: "home", loader: () => ({ hi: "lazy" }) }),
    "_404.tsx": make({ default: "nf" }),
  }
  const manifest = buildManifest(
    Object.keys(loaders),
    (file) => () => loaders[file]?.() as Promise<RouteModule>,
  )
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  expect(await (await app.fetch(new Request("http://x/"))).text()).toContain(
    'chain=2:{"hi":"lazy"}',
  )
  // The index + its layout were loaded on demand (lazily) when the route was hit.
  expect(loaded).toContain("home")
  expect(loaded).toContain("layout")
})
