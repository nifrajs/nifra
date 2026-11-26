import { describe, expect, test } from "bun:test"
import {
  CODE_ATTRIBUTE,
  SMIL_TAG,
  URL_ATTRIBUTE,
  URL_BLOCKED_TAG,
} from "../../web/src/internal/island-bindings.ts"
import { runRuleRegistry, sourceIndex } from "../src/rules/index.ts"
import {
  islandRules,
  REFUSED_CODE_ATTRIBUTE,
  REFUSED_SMIL_TAG,
  REFUSED_URL_ATTRIBUTE,
  REFUSED_URL_TAG,
} from "../src/rules/islands.ts"
import { projectFacts } from "./rule-facts.ts"

async function scan(...files: Array<{ file: string; content: string }>) {
  const facts = { ...projectFacts("app/x.ts", ""), source: sourceIndex(files) }
  return runRuleRegistry(
    { root: process.cwd(), sources: facts.source, project: facts },
    islandRules,
  )
}
const codes = (findings: readonly { code: string }[]) => findings.map((f) => f.code).sort()
const client = (...lines: string[]) => ({
  file: "routes/app.client.ts",
  content: [
    'import { bindIsland, defineIsland, mountIslands } from "@nifrajs/web/islands"',
    ...lines,
  ].join("\n"),
})
const page = (markup: string) => ({
  file: "routes/app.tsx",
  content: [
    'import { html, islandProps } from "@nifrajs/web-vanilla"',
    `export default () => html\`${markup}\``,
  ].join("\n"),
})
const jsx = (body: string, from = "@nifrajs/web-react/island") => ({
  file: "routes/app.tsx",
  content: `import { Island } from "${from}"\nexport default () => (${body})`,
})

describe("NF-C064 island host with no enhancer", () => {
  const mounted = client(
    "mountIslands({ cart: bindIsland(() => {}), clock: defineIsland(() => {}) })",
  )

  test("flags a host whose id no mount call lists, and names the ids that are mounted", async () => {
    const findings = await scan(mounted, page('<div data-island="crat"></div>'))
    expect(codes(findings)).toEqual(["NF-C064"])
    expect(findings[0]?.message).toContain('"crat"')
    expect(findings[0]?.evidence).toContain("mounted: cart, clock")
    expect(findings[0]?.severity).toBe("warn")
  })

  test("passes a mounted id in an html template, in JSX and as an Island marker", async () => {
    expect(codes(await scan(mounted, page('<div data-island="cart"></div>')))).toEqual([])
    expect(codes(await scan(mounted, jsx('<div data-island="clock" />')))).toEqual([])
    expect(codes(await scan(mounted, jsx('<Island id="cart" />')))).toEqual([])
    expect(codes(await scan(mounted, jsx('<Island id="cart2" />')))).toEqual(["NF-C064"])
  })

  test("reads every literal key form of a mount map", async () => {
    const map = client(
      "const b = defineIsland(() => {})",
      'mountIslands({ a: defineIsland(() => {}), "b-c": b, 3: b, d(el) {}, b })',
    )
    const markup = ["a", "b-c", "3", "d", "b"].map((id) => `<i data-island="${id}"></i>`).join("")
    expect(codes(await scan(map, page(markup)))).toEqual([])
  })

  test("stays silent when a mount call hides ids from the scan", async () => {
    const markup = page('<div data-island="anything"></div>')
    for (const hidden of [
      "mountIslands(enhancers)",
      "mountIslands({ ...shared, cart: bindIsland(() => {}) })",
      "mountIslands({ [name]: bindIsland(() => {}) })",
      "islands.mountIslands({ a: bindIsland(() => {}) })",
      "mountIslands({ a: bindIsland(() => {}) })\nmountIslands(more)",
    ])
      expect(codes(await scan(client(hidden), markup))).toEqual([])
    const renamed = {
      file: "routes/app.client.ts",
      content: [
        'import { mountIslands as mount } from "@nifrajs/web/islands"',
        "mount({ a: () => {} })",
      ].join("\n"),
    }
    expect(codes(await scan(renamed, markup))).toEqual([])
  })

  test("stays silent without a mount call to compare against, and for an id that is not literal", async () => {
    expect(codes(await scan(page('<div data-island="cart"></div>')))).toEqual([])
    expect(codes(await scan(mounted, page('<div data-island="${id}"></div>')))).toEqual([])
    expect(codes(await scan(mounted, jsx("<div data-island={id} />")))).toEqual([])
  })

  test("enableSwap's map counts as mounting", async () => {
    const swap = {
      file: "routes/app.client.ts",
      content: [
        'import { enableSwap } from "@nifrajs/web/islands/swap"',
        "enableSwap({ cart: () => {} })",
      ].join("\n"),
    }
    expect(codes(await scan(swap, page('<div data-island="cart"></div>')))).toEqual([])
  })
})

describe("island rules: escape hatch and component identity", () => {
  const mounted = client("mountIslands({ cart: bindIsland(() => {}) })")
  const typed = client("mountIslands({ cart: defineIsland<{ n: number }>(() => {}) })")

  test("a nifra-expect comment with a reason silences NF-C064, in JSX and in an html template", async () => {
    const inJsx = jsx(
      '<div>\n  {/* nifra-expect NF-C064: mounted by the host app */}\n  <i data-island="far" />\n</div>',
    )
    expect(codes(await scan(mounted, inJsx))).toEqual([])
    const inline = jsx(
      '<div>\n  <i data-island="far" /> {/* nifra-expect NF-C064: elsewhere */}\n</div>',
    )
    expect(codes(await scan(mounted, inline))).toEqual([])
    const inHtml = page(
      '\n<!-- nifra-expect NF-C064: mounted by the host app -->\n<p data-island="far"></p>',
    )
    expect(codes(await scan(mounted, inHtml))).toEqual([])
  })

  test("a marker with no reason, or for another code, silences nothing and says why", async () => {
    const bare = {
      file: "routes/app.tsx",
      content:
        'const el =\n  // nifra-expect NF-C064:\n  <i data-island="far" />\nexport default () => el',
    }
    const findings = await scan(mounted, bare)
    expect(codes(findings)).toEqual(["NF-C064"])
    expect(findings[0]?.message).toContain("gives no reason")
    const other = jsx(
      '<div>\n  {/* nifra-expect NF-C065: nope */}\n  <i data-island="far" />\n</div>',
    )
    expect(codes(await scan(mounted, other))).toEqual(["NF-C064"])
    const apart = jsx(
      '<div>\n  {/* nifra-expect NF-C064: x */}\n\n  <i data-island="far" />\n</div>',
    )
    expect(codes(await scan(mounted, apart))).toEqual(["NF-C064"])
  })

  test("a nifra-expect comment silences NF-C065 for its host only", async () => {
    const markup = jsx(
      '<div>\n  {/* nifra-expect NF-C065: seeded client-side */}\n  <Island id="cart" />\n  <Island id="cart" />\n</div>',
    )
    const findings = await scan(typed, markup)
    expect(codes(findings)).toEqual(["NF-C065"])
    expect(findings[0]?.line).toBe(5)
  })

  test("an Island that is not imported from a @nifrajs package takes other props, so it is not judged", async () => {
    const own = jsx(
      '<Island id="cart" data={{ n: 1 }} /><Island id="ghost" />',
      "./components/island",
    )
    expect(codes(await scan(typed, own))).toEqual([])
    const nifra = jsx('<Island id="cart" /><Island id="ghost" />')
    expect(codes(await scan(typed, nifra))).toEqual(["NF-C064", "NF-C065"])
  })
})

describe("NF-C065 island props contract", () => {
  const typed = client(
    "mountIslands({",
    "  counter: defineIsland<{ start: number; label?: string; tone: 'a' | 'b'; on: boolean }>(() => {}),",
    "  list: bindIsland<{ items: string[] }>(() => {}),",
    "  plain: defineIsland((el, props: { id: string; note: string | undefined }) => {}),",
    "  loose: defineIsland<Props>(() => {}),",
    "})",
  )
  const counter = (props: string) =>
    page(`<div data-island="counter" data-island-props="\${islandProps(${props})}"></div>`)

  test("passes props that satisfy the type, with an optional one left out", async () => {
    expect(codes(await scan(typed, counter("{ start: 0, tone: 'a', on: true }")))).toEqual([])
    expect(
      codes(await scan(typed, counter("{ start: -1, tone: 'b', on: false, label: 'x' }"))),
    ).toEqual([])
  })

  test("flags a missing required prop, an undeclared one and a literal of the wrong kind", async () => {
    const findings = await scan(typed, counter("{ start: '0', tone: 'a', extra: 1 }"))
    expect(codes(findings)).toEqual(["NF-C065", "NF-C065", "NF-C065"])
    const messages = findings.map((f) => f.message).join("\n")
    expect(messages).toContain('does not pass "on"')
    expect(messages).toContain('passes "extra", which the enhancer\'s props type does not declare')
    expect(messages).toContain('passes "start" as a string, which the enhancer declares as number')
  })

  test("a null literal is not a number, and a string is not a union of literals of another kind", async () => {
    const findings = await scan(typed, counter("{ start: null, tone: 3, on: true }"))
    expect(findings.map((f) => f.message).sort()).toEqual([
      'island "counter" passes "start" as null, which the enhancer declares as number',
      'island "counter" passes "tone" as a number, which the enhancer declares as string',
    ])
  })

  test("a host with no props is judged against the required ones", async () => {
    const findings = await scan(typed, page('<div data-island="counter"></div>'))
    expect(findings.map((f) => f.message)).toEqual([
      'island "counter" does not pass "start", which the enhancer\'s props type requires',
      'island "counter" does not pass "tone", which the enhancer\'s props type requires',
      'island "counter" does not pass "on", which the enhancer\'s props type requires',
    ])
    expect(codes(await scan(typed, page('<div data-island="plain"></div>')))).toEqual(["NF-C065"])
  })

  test("a spread may supply the missing props, but an undeclared key is still reported", async () => {
    expect(codes(await scan(typed, counter("{ ...rest }")))).toEqual([])
    expect(codes(await scan(typed, counter("{ ...rest, nope: 1 }")))).toEqual(["NF-C065"])
  })

  test("reads a parameter annotation, a bindIsland type argument and literal JSON", async () => {
    const plain = (props: string) =>
      page(`<div data-island="plain" data-island-props='${props}'></div>`)
    expect(codes(await scan(typed, plain('{"id":"a"}')))).toEqual([])
    expect(codes(await scan(typed, plain('{"id":1}')))).toEqual(["NF-C065"])
    expect(codes(await scan(typed, plain("{&quot;id&quot;:&quot;a&quot;}")))).toEqual([])
    const list = (props: string) =>
      page(`<div data-island="list" data-island-props="\${islandProps(${props})}"></div>`)
    expect(codes(await scan(typed, list("{ items: [] }")))).toEqual([])
    expect(codes(await scan(typed, list("{}")))).toEqual(["NF-C065"])
  })

  test("judges JSX props on an Island marker and on a data-island element", async () => {
    expect(
      codes(
        await scan(typed, jsx('<Island id="counter" props={{ start: 1, tone: "a", on: true }} />')),
      ),
    ).toEqual([])
    expect(
      codes(
        await scan(
          typed,
          jsx('<Island id="counter" props={{ start: "1", tone: "a", on: true }} />'),
        ),
      ),
    ).toEqual(["NF-C065"])
    expect(codes(await scan(typed, jsx('<Island id="counter" />')))).toEqual([
      "NF-C065",
      "NF-C065",
      "NF-C065",
    ])
    expect(
      codes(
        await scan(
          typed,
          jsx('<div data-island="counter" data-island-props={JSON.stringify({ start: 1 })} />'),
        ),
      ),
    ).toEqual(["NF-C065", "NF-C065"])
  })

  test("stays silent when either side cannot be read", async () => {
    for (const props of [
      "props",
      "makeProps()",
      "{ ...a }.x",
      "islandProps(p)",
      "islandProps({ x() {} })",
    ])
      expect(
        codes(
          await scan(
            typed,
            page(`<div data-island="counter" data-island-props="\${${props}}"></div>`),
          ),
        ),
      ).toEqual([])
    // A type reference, an id with no type, a spread attribute and an interpolated attribute name.
    expect(codes(await scan(typed, page('<div data-island="loose"></div>')))).toEqual([])
    expect(codes(await scan(typed, jsx('<Island id="counter" {...rest} />')))).toEqual([])
    expect(codes(await scan(typed, page('<div data-island="counter" ${attrs}></div>')))).toEqual([])
    expect(
      codes(
        await scan(typed, page("<div data-island=\"counter\" data-island-props='not json'></div>")),
      ),
    ).toEqual([])
    expect(
      codes(await scan(typed, page('<div data-island="counter" data-island-props="x${1}"></div>'))),
    ).toEqual([])
  })
})

describe("NF-C066 island attribute binding the runtime refuses", () => {
  const withHost = (tag: string, spec: string) =>
    page(`<div data-island="cart"><${tag} data-bind-attr="${spec}"></${tag}></div>`)
  const mount = client("mountIslands({ cart: bindIsland(({ state }) => { state('u', '') }) })")

  test("flags event-handler and srcdoc attributes", async () => {
    const findings = await scan(mount, withHost("button", "onclick:u,srcdoc:u,ONFOCUS:u,title:u"))
    expect(codes(findings)).toEqual(["NF-C066", "NF-C066", "NF-C066"])
    expect(findings[0]?.message).toContain("event-handler or srcdoc")
  })

  test("flags a URL attribute on script, iframe, object, embed, link and base only", async () => {
    for (const [tag, attr] of [
      ["script", "src"],
      ["iframe", "src"],
      ["object", "data"],
      ["embed", "src"],
      ["link", "href"],
      ["base", "href"],
    ] as const) {
      const findings = await scan(mount, withHost(tag, `${attr}:u`))
      expect(codes(findings)).toEqual(["NF-C066"])
      expect(findings[0]?.message).toContain(`<${tag}>`)
    }
    for (const [tag, attr] of [
      ["a", "href"],
      ["img", "src"],
      ["form", "action"],
      ["script", "type"],
      ["iframe", "title"],
    ] as const)
      expect(codes(await scan(mount, withHost(tag, `${attr}:u`)))).toEqual([])
  })

  test("flags any attribute bound on an SVG animation element, and a div is left alone", async () => {
    for (const tag of ["set", "animate", "animateMotion", "animateTransform"]) {
      const findings = await scan(mount, withHost(tag, "to:u,values:u,dur:u"))
      expect(codes(findings)).toEqual(["NF-C066", "NF-C066", "NF-C066"])
      expect(findings[0]?.message).toContain(`<${tag.toLowerCase()}>`)
    }
    expect(codes(await scan(mount, withHost("div", "to:u,values:u")))).toEqual([])
  })

  test("reads a JSX binding, and ignores the other binding kinds", async () => {
    expect(
      codes(
        await scan(mount, jsx('<div data-island="cart"><script data-bind-attr="src:u" /></div>')),
      ),
    ).toEqual(["NF-C066"])
    expect(codes(await scan(mount, withHost("script", "u")))).toEqual([])
    expect(
      codes(
        await scan(
          mount,
          page('<div data-island="cart"><script data-bind-text="u"></script></div>'),
        ),
      ),
    ).toEqual([])
  })
})

describe("NF-C066 stays in step with the runtime", () => {
  test("the checker refuses exactly what the binding runtime refuses", () => {
    expect(REFUSED_CODE_ATTRIBUTE.source).toBe(CODE_ATTRIBUTE.source)
    expect(REFUSED_CODE_ATTRIBUTE.flags).toBe(CODE_ATTRIBUTE.flags)
    expect(REFUSED_URL_ATTRIBUTE.source).toBe(URL_ATTRIBUTE.source)
    expect(REFUSED_URL_ATTRIBUTE.flags).toBe(URL_ATTRIBUTE.flags)
    const runtimeTags = new Set(/\(\?:(.*)\)/.exec(URL_BLOCKED_TAG.source)?.[1]?.split("|"))
    expect(runtimeTags).toEqual(new Set(REFUSED_URL_TAG))
    const smilTags = new Set(/\(\?:(.*)\)/.exec(SMIL_TAG.source)?.[1]?.split("|"))
    expect(smilTags).toEqual(new Set(REFUSED_SMIL_TAG))
    for (const tag of ["a", "img", "form", "video", "source", "button", "svg", "use"])
      expect(URL_BLOCKED_TAG.test(tag) || REFUSED_URL_TAG.has(tag)).toBe(false)
  })
})
