import { describe, expect, test } from "bun:test"
import type { PluginBuilder } from "../src/plugins/kit.ts"
import {
  type SvgOptimizer,
  svgComponentBunPlugin,
  svgComponentSource,
  svgToJsx,
} from "../src/plugins/svg.ts"

type LoadCb = (args: {
  path: string
}) => Promise<{ contents: string; loader: string }> | { contents: string; loader: string }

function setupPlugin(svgo?: boolean | SvgOptimizer) {
  let load: LoadCb | undefined
  svgComponentBunPlugin("dom", svgo === undefined ? {} : { svgo }).setup({
    onLoad: (opts: { namespace?: string }, cb: LoadCb) => {
      if (opts.namespace === undefined) load = cb
    },
    onResolve: () => {},
  } as unknown as PluginBuilder)
  return load as LoadCb
}

describe("svgToJsx (transform)", () => {
  const jsx = svgToJsx(
    `<?xml version="1.0"?><!-- c --><svg class="icon" stroke-width="2" style="color:red;font-size:2px"><path fill-rule="evenodd" xlink:href="#a"/></svg>`,
  )

  test("spreads {...props} onto the root svg", () => {
    expect(jsx).toMatch(/^<svg \{\.\.\.props\}/)
  })
  test("maps class → className", () => {
    expect(jsx).toContain('className="icon"')
    expect(jsx).not.toContain("class=")
  })
  test("camelCases hyphenated attributes", () => {
    expect(jsx).toContain('strokeWidth="2"')
    expect(jsx).toContain("fillRule=")
    expect(jsx).not.toContain("stroke-width")
  })
  test("camelCases namespaced attributes", () => {
    expect(jsx).toContain('xlinkHref="#a"')
    expect(jsx).not.toContain("xlink:href")
  })
  test("parses inline style into a JSX object", () => {
    expect(jsx).toContain('style={{"color":"red","fontSize":"2px"}}')
  })
  test("strips XML declaration and comments", () => {
    expect(jsx).not.toContain("<?xml")
    expect(jsx).not.toContain("<!--")
  })
})

describe("svgComponentSource", () => {
  test("emits a default-exported component that returns the JSX", () => {
    const src = svgComponentSource('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>')
    expect(src).toContain("export default function SvgComponent(props)")
    expect(src).toContain("<svg {...props}")
    expect(src).toContain("<path")
  })

  test("the emitted JSX actually compiles (Bun's JSX transpiler accepts it)", () => {
    const src = svgComponentSource(
      `<svg class="icon" stroke-width="2" style="color:red"><path fill-rule="evenodd" xlink:href="#a" d="M0 0"/></svg>`,
    )
    const js = new Bun.Transpiler({ loader: "jsx" }).transformSync(src)
    expect(js).toContain("SvgComponent")
    expect(js.length).toBeGreaterThan(0) // no throw ⇒ valid JSX
  })
})

describe("svgComponentBunPlugin", () => {
  const fixture = `${new URL("./fixtures/icon.svg?component", import.meta.url).pathname}?component`

  test("intercepts *.svg?component and emits a JSX component module", async () => {
    const load = setupPlugin()
    const out = await load({ path: fixture })
    expect(out.loader).toBe("jsx")
    expect(out.contents).toContain("export default function SvgComponent(props)")
    expect(out.contents).toContain("<svg {...props}")
    expect(out.contents).toContain('className="icon"')
    expect(out.contents).toContain('strokeWidth="2"')
  })

  test("runs the injected SVGO optimizer before emitting", async () => {
    const calls: string[] = []
    const svgo: SvgOptimizer = {
      optimize(input) {
        calls.push(input)
        return { data: '<svg class="opt"><path d="M0 0"/></svg>' }
      },
    }
    const out = await setupPlugin(svgo)({ path: fixture })
    expect(calls).toHaveLength(1)
    expect(out.contents).toContain('className="opt"')
  })

  test("an SVGO failure is attributed to the file + package", async () => {
    const svgo: SvgOptimizer = {
      optimize() {
        throw new Error("bad node")
      },
    }
    await expect(setupPlugin(svgo)({ path: fixture })).rejects.toThrow(
      /\[nifra\/web\] failed to optimize .*icon\.svg: bad node/,
    )
  })
})
