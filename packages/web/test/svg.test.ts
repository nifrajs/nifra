import { describe, expect, test } from "bun:test"
import type { PluginBuilder } from "../src/plugins/kit.ts"
import {
  type SvgOptimizer,
  stripSvgPreamble,
  svgComponentBunPlugin,
  svgComponentSource,
  svgTemplateMarkup,
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

describe("stripSvgPreamble", () => {
  test("removes declaration, comments, and DOCTYPE in one pass", () => {
    const out = stripSvgPreamble(
      `<?xml version="1.0"?><!-- a --><!DOCTYPE svg PUBLIC "x"><svg><!-- b --><path/></svg>`,
    )
    expect(out).toBe("<svg><path/></svg>")
  })

  test("removed delimiters cannot splice into a new marker", () => {
    // A sequential-replace pipeline turns this into `<!DOCTYPE …>` after the comment is removed;
    // the scanner must not recombine the halves.
    expect(stripSvgPreamble("<<!---->!DOCTYPE svg><svg/>")).toBe("<!DOCTYPE svg><svg/>")
  })

  test("an unterminated marker swallows the rest of the input (parser semantics)", () => {
    expect(stripSvgPreamble("<svg/><?xml version")).toBe("<svg/>")
    expect(stripSvgPreamble("<svg/><!-- open")).toBe("<svg/>")
    expect(stripSvgPreamble("<svg/><!DOCTYPE svg")).toBe("<svg/>")
  })

  test("adversarial marker runs stay fast (linear scan, no backtracking)", () => {
    const start = performance.now()
    stripSvgPreamble(`${"<?".repeat(20_000)}<svg/>`)
    expect(performance.now() - start).toBeLessThan(200)
  })
})

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

describe("an SVG file never reaches a template as code", () => {
  test("JSX text holds braces, > and = as character references: a stylesheet compiles, an expression stays text", () => {
    const src = svgComponentSource(
      "<svg><style>.st0{fill:#FFF;} a > b {}</style><title>{(globalThis.svgRan = 1)}</title><text><![CDATA[x{y}<z]]></text></svg>",
    )
    expect(src).toContain("<style>.st0&#123;fill:#FFF;&#125; a &#62; b &#123;&#125;</style>")
    expect(src).toContain("<title>&#123;(globalThis.svgRan &#61; 1)&#125;</title>")
    expect(src).toContain("<text>x&#123;y&#125;&lt;z</text>")
    expect(() => new Bun.Transpiler({ loader: "jsx" }).transformSync(src)).not.toThrow()
  })

  test.each([
    [
      "content after the root",
      "<svg/>)} globalThis.x=1; function f(){return (<g/>",
      "content after the root </svg>",
    ],
    [
      "a spread in a tag",
      "<svg><path {...evil}/></svg>",
      '<path> holds "{" where an attribute belongs',
    ],
    [
      "an element JSX reads as a value",
      "<svg><globalThis.process.exit/></svg>",
      "the element <globalThis.process.exit>",
    ],
    ["a capitalized element", "<svg><Function/></svg>", "the element <Function>"],
    [
      "a valueless attribute",
      "<svg><g use:alert/></svg>",
      "the attribute use:alert on <g> has no value",
    ],
    [
      "an unquoted value",
      "<svg><path d=M0/></svg>",
      "the value of d on <path> is not a quoted string",
    ],
    ["markup with no svg root", "<g/>", "it does not start with an <svg> element"],
    ["an unclosed root", "<svg><g>", "the root <svg> element is not closed"],
  ])("JSX refuses %s", (_name, svg, message) => {
    expect(() => svgToJsx(svg)).toThrow(message)
  })

  test("raw-text elements are copied as written until their closing tag, in any case", () => {
    const rules = { text: (text: string) => text.toUpperCase(), rawText: new Set(["style"]) }
    expect(svgTemplateMarkup("<svg><style>a{}</STYLE>b</svg>", rules)).toBe(
      "<svg><style>a{}</STYLE>B</svg>",
    )
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
