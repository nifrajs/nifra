import { describe, expect, test } from "bun:test"
import { cloudflareLoader } from "@nifrajs/image"
import { h } from "preact"
import { renderToString } from "preact-render-to-string"
import { Image } from "../src/image.ts"

const render = (props: Parameters<typeof Image>[0]): string =>
  renderToString(h(Image, props)).toLowerCase()

describe("@nifrajs/web-preact/image", () => {
  test("identity loader: CLS-safe img (width/height/alt, lazy, async-decode, no srcset)", () => {
    const html = render({ src: "/a.png", width: 200, height: 100, alt: "a" })
    expect(html).toContain('src="/a.png"')
    expect(html).toContain('width="200"')
    expect(html).toContain('height="100"')
    expect(html).toContain('alt="a"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
    expect(html).not.toContain("srcset") // identity loader → every width is the same URL
    expect(html).not.toContain("fetchpriority")
  })

  test("CDN loader: responsive srcset + 1× src fallback", () => {
    const html = render({
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

  test("priority → eager + fetchpriority=high (LCP image)", () => {
    const html = render({
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

  test("forwards extra DOM props; never leaks nifra-only props to the DOM", () => {
    const html = render({
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
    expect(() => render({ src: "/a", width: 0, height: 10, alt: "" })).toThrow(
      /positive width \+ height/,
    )
  })
})
