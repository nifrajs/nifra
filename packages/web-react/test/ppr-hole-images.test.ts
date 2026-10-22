import { expect, test } from "bun:test"
import { createWebApp, type Manifest } from "@nifrajs/web"
import { partialPrerendering } from "@nifrajs/web/ppr"
import { createElement as h, type ReactNode } from "react"
import { reactAdapter } from "../src/index.ts"
import { Hole, type HoleDefinition } from "../src/ppr.ts"

// React writes `<link rel="preload" as="image">` ahead of a fragment's `<img>`; a hole's HTML
// refuses `<link>`, so an ordinary image once turned the whole hole into its error frame.
type Photo = { readonly src: string }
const image = (data: Photo): ReactNode =>
  h("figure", null, h("img", { src: data.src, alt: "Product" }))
const photo: HoleDefinition<Photo> & { readonly mode: "dynamic" } = {
  name: "photo",
  mode: "dynamic",
  render: image,
  fallback: h("p", null, "..."),
}
const gallery = { ...photo, name: "gallery", interactive: true }

test("an image in a plain or an interactive hole fills it, with no resource hint in the frame", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "p",
        pattern: "/p",
        layoutIds: [],
        file: "p.tsx",
        load: async () => ({
          default: (props: { readonly boundaries?: Record<string, never> }) =>
            h(
              "main",
              null,
              h(Hole<Photo>, { of: photo, state: props.boundaries?.photo }),
              h(Hole<Photo>, { of: gallery, state: props.boundaries?.gallery }),
            ),
          shellLoader: () => ({}),
          boundaries: [
            { ...photo, load: () => ({ src: "/a.png" }) },
            { ...gallery, load: () => ({ src: "/b.png" }) },
          ],
        }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({
    adapter: reactAdapter,
    manifest,
    clientEntry: "/c.js",
    experimental: { ppr: partialPrerendering({ shellChecks: "unchecked-development" }) },
  })
  const html = await (await app.fetch(new Request("http://shop.test/p"))).text()
  const frame = (name: string): string =>
    new RegExp(`id="nifra-ppr:${name}">(.*?)</script>`).exec(html)?.[1] ?? ""
  expect(frame("photo")).toBe(
    '{"v":1,"html":"<figure><img src=\\"/a.png\\" alt=\\"Product\\"/><\\/figure>"}',
  )
  expect(frame("gallery")).toStartWith(
    '{"v":1,"html":"<figure><img src=\\"/b.png\\" alt=\\"Product\\"/><\\/figure>","props":',
  )
})

test("only the hints go: the markup after them is unchanged", async () => {
  const html = await reactAdapter.renderFragment?.(
    () => h("p", null, h("img", { src: "/a.png", alt: "" }), h("a", { href: "/next" }, "next")),
    {},
  )
  expect(html).toBe('<p><img src="/a.png" alt=""/><a href="/next">next</a></p>')
})
