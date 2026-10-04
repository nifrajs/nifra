import { describe, expect, test } from "bun:test"
import { svelteSvgComponentBunPlugin, svgToSvelte } from "../src/svg.ts"

type LoadCb = (args: { path: string }) => Promise<{ contents: string; loader: string }>

function setup(generate: "dom" | "ssr" = "dom") {
  let load: LoadCb | undefined
  svelteSvgComponentBunPlugin(generate).setup({
    onLoad: (_o: unknown, cb: LoadCb) => {
      load = cb
    },
    onResolve: () => {},
  } as never)
  return load as LoadCb
}

const fixture = `${new URL("./fixtures/icon.svg", import.meta.url).pathname}?component`

describe("svgToSvelte (transform)", () => {
  test("wraps in a Svelte 5 component, spreads props onto the root svg, keeps class verbatim", () => {
    const src = svgToSvelte(
      '<?xml version="1.0"?><svg class="icon" stroke-width="2"><path d="M0"/></svg>',
    )
    expect(src).toContain("const props = $props()")
    expect(src).toMatch(/<svg\b[^>]*\{\.\.\.props\}>/) // spread after the svg's own attrs (user props win)
    expect(src).toContain('class="icon"') // Svelte accepts class as-is (no className)
    expect(src).toContain('stroke-width="2"') // hyphenated attrs kept verbatim
    expect(src).not.toContain("<?xml")
  })
})

describe("svgToSvelte keeps the SVG out of Svelte syntax", () => {
  test("braces in text and attribute values stay text; a nested <style> stays raw", () => {
    const src = svgToSvelte(
      '<svg><style>.a{fill:red}</style><title>{(globalThis.svgRan = 1)}</title><path data-x="{1}"/></svg>',
    )
    expect(src).toContain("<style>.a{fill:red}</style>")
    expect(src).toContain("<title>&#123;(globalThis.svgRan = 1)&#125;</title>")
    expect(src).toContain('data-x="&#123;1&#125;"')
  })

  test.each([
    [
      "a directive",
      '<svg><path use:alert=""/></svg>',
      "the attribute use:alert is a Svelte directive",
    ],
    ["a special element", "<svg><svelte:head></svelte:head></svg>", "the element <svelte:head>"],
    ["a script after the root", "<svg></svg><script module>x()</script>", "content after the root"],
  ])("refuses %s", (_name, svg, message) => {
    expect(() => svgToSvelte(svg)).toThrow(message)
  })
})

describe("svelteSvgComponentBunPlugin", () => {
  test("compiles a *.svg?component into a Svelte component module (real compiler)", async () => {
    const out = await setup("dom")({ path: fixture })
    expect(out.loader).toBe("js")
    expect(out.contents.length).toBeGreaterThan(0) // svelte compiled the component without throwing
  })

  test("ssr generate produces server output", async () => {
    const ssr = await setup("ssr")({ path: fixture })
    expect(ssr.contents.length).toBeGreaterThan(0)
  })
})
