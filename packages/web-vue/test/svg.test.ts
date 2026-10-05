import { describe, expect, test } from "bun:test"
import { svgToVueSfc, vueSvgComponentBunPlugin } from "../src/svg.ts"

type LoadCb = (args: { path: string }) => Promise<{ contents: string; loader: string }>

function setup(generate: "dom" | "ssr" = "dom") {
  let load: LoadCb | undefined
  vueSvgComponentBunPlugin(generate).setup({
    onLoad: (_o: unknown, cb: LoadCb) => {
      load = cb
    },
    onResolve: () => {},
  } as never)
  return load as LoadCb
}

const fixture = `${new URL("./fixtures/icon.svg", import.meta.url).pathname}?component`

describe("svgToVueSfc (transform)", () => {
  test("wraps raw SVG in a template-only SFC (single root inherits attrs), keeps class verbatim", () => {
    const sfc = svgToVueSfc(
      '<?xml version="1.0"?><svg class="icon" stroke-width="2"><path d="M0"/></svg>',
    )
    expect(sfc).toContain("<template>")
    expect(sfc).toContain("<svg")
    expect(sfc).toContain('class="icon"') // Vue accepts class as-is
    expect(sfc).toContain('stroke-width="2"')
    expect(sfc).not.toContain("<?xml")
  })
})

describe("svgToVueSfc keeps the SVG out of Vue template syntax", () => {
  test("the root carries v-pre, so no {{ }}, :bound or v- attribute compiles", () => {
    const sfc = svgToVueSfc(
      '<svg><title>{{ $options }}</title><rect :x="evil" v-html="evil"/></svg>',
    )
    expect(sfc).toContain("<template><svg v-pre>")
  })

  test("refuses a <template> tag, which could end the SFC block, even in a CDATA section", () => {
    expect(() =>
      svgToVueSfc("<svg><text><![CDATA[</template><script setup>x()</script>]]></text></svg>"),
    ).toThrow("cannot hold a <template> tag")
  })
})

describe("vueSvgComponentBunPlugin", () => {
  test("compiles a *.svg?component into a Vue component module (real compiler)", async () => {
    const out = await setup("dom")({ path: fixture })
    expect(out.loader).toBe("js")
    expect(out.contents.length).toBeGreaterThan(0)
    expect(out.contents).toContain("render") // compiled template binds a render fn
  })

  test("ssr generate binds ssrRender", async () => {
    const ssr = await setup("ssr")({ path: fixture })
    expect(ssr.contents).toContain("ssrRender")
  })
})
