import { describe, expect, test } from "bun:test"
import { cloudflareLoader } from "@nifrajs/image"
import { createSSRApp } from "vue"
import { renderToString } from "vue/server-renderer"
import { Image } from "../src/image.ts"

// Mount Image as the SSR root with `props` as root props (Vue's `createSSRApp(comp, rootProps)`
// takes a plain record; `h(comp, …)` would demand the component's exact prop type).
const render = async (props: Record<string, unknown>): Promise<string> =>
  (await renderToString(createSSRApp(Image, props))).toLowerCase()

describe("@nifrajs/web-vue/image", () => {
  test("identity loader: CLS-safe img (width/height/alt, lazy, async-decode, no srcset)", async () => {
    const html = await render({ src: "/a.png", width: 200, height: 100, alt: "a" })
    expect(html).toContain('src="/a.png"')
    expect(html).toContain('width="200"')
    expect(html).toContain('height="100"')
    expect(html).toContain('alt="a"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
    expect(html).not.toContain("srcset")
    expect(html).not.toContain("fetchpriority")
  })

  test("CDN loader: responsive srcset + 1× src fallback", async () => {
    const html = await render({
      src: "/hero.jpg",
      width: 400,
      height: 300,
      alt: "h",
      loader: cloudflareLoader(),
    })
    expect(html).toContain('src="/cdn-cgi/image/format=auto,width=400/hero.jpg"')
    expect(html).toContain(
      'srcset="/cdn-cgi/image/format=auto,width=400/hero.jpg 400w, /cdn-cgi/image/format=auto,width=800/hero.jpg 800w"',
    )
  })

  test("priority → eager + fetchpriority=high (LCP image)", async () => {
    const html = await render({
      src: "/lcp.jpg",
      width: 800,
      height: 600,
      alt: "",
      priority: true,
      loader: cloudflareLoader(),
    })
    expect(html).toContain('loading="eager"')
    expect(html).toContain('fetchpriority="high"')
  })

  test("forwards extra attrs (class/id); never leaks nifra-only props to the DOM", async () => {
    const html = await render({
      src: "/x.png",
      width: 50,
      height: 50,
      alt: "x",
      class: "rounded",
      id: "avatar",
      widths: [50, 100, 150],
      quality: 80,
      priority: false,
    })
    expect(html).toContain('class="rounded"')
    expect(html).toContain('id="avatar"')
    expect(html).not.toContain("widths")
    expect(html).not.toContain("quality")
    expect(html).not.toContain("priority")
  })

  test("CLS contract: a non-positive dimension throws at render", () => {
    expect(render({ src: "/a", width: 0, height: 10, alt: "" })).rejects.toThrow(
      /positive width \+ height/,
    )
  })
})
