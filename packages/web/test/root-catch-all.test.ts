import { expect, test } from "bun:test"
import { buildManifest, createWebApp, type RenderAdapter } from "../src/index.ts"

const stub: RenderAdapter = {
  renderToStream: (_chain, props) =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`<p>${JSON.stringify(props.params)}</p>`))
        c.close()
      },
    }),
  hydrationHead: () => "",
}

test("a root catch-all page answers every path, the root included", async () => {
  for (const [files, path, params] of [
    [["[...all].tsx"], "/a/b", { all: "a/b" }],
    [["[...all].tsx"], "/", { all: "" }],
    [["index.tsx", "[...slug].tsx"], "/docs/intro", { slug: "docs/intro" }],
    [["[[lang]]/[...rest].tsx"], "/pricing", { rest: "pricing" }],
  ] as const) {
    const manifest = buildManifest([...files], () => async () => ({ default: "page" }))
    const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
    const res = await app.fetch(new Request(`http://x${path}`))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(`<p>${JSON.stringify(params)}</p>`)
  }
})

test("without a root catch-all, an unmatched path still reaches the 404 fallback", async () => {
  const manifest = buildManifest(["index.tsx", "docs/[...slug].tsx"], () => async () => ({
    default: "page",
  }))
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  expect((await app.fetch(new Request("http://x/missing"))).status).toBe(404)
})
