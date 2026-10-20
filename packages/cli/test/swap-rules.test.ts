import { describe, expect, test } from "bun:test"
import { explainRule } from "../src/rule-explain.ts"
import { runRuleRegistry, sourceIndex } from "../src/rules/index.ts"
import { islandRules } from "../src/rules/islands.ts"
import { swapRules } from "../src/rules/swap.ts"
import { projectFacts } from "./rule-facts.ts"

async function scan(...files: Array<{ file: string; content: string }>) {
  const facts = { ...projectFacts("app/x.ts", ""), source: sourceIndex(files) }
  return runRuleRegistry({ root: process.cwd(), sources: facts.source, project: facts }, [
    ...islandRules,
    ...swapRules,
  ])
}
const codes = (findings: readonly { code: string }[]) => findings.map((f) => f.code).sort()

/** A vanilla route file whose default export renders `markup`. */
const page = (file: string, markup: string, imports = "html, slot") => ({
  file,
  content: [
    `import { ${imports} } from "@nifrajs/web-vanilla"`,
    "const rows: string[] = []",
    `export default () => html\`${markup}\``,
  ].join("\n"),
})

const LIST = `<ul data-swap-slot="results">\${slot("results", rows)}</ul>`

describe("a well-formed swap", () => {
  test("a link, a form and their slot raise nothing", async () => {
    const markup = `<form action="/hotels" data-swap="replace:results"><input name="q"></form><a href="?page=2" data-swap="append:results">More</a>${LIST}`
    expect(codes(await scan(page("routes/hotels.tsx", markup)))).toEqual([])
  })
})

describe("NF-C049 swap link or form misdeclared", () => {
  test("flags data-swap off a link or form, a link without href, and a bad mode", async () => {
    const findings = await scan(
      page(
        "routes/hotels.tsx",
        `<button data-swap="replace:results">x</button><a data-swap="replace:results">x</a><a href="/x" data-swap="swap:results">x</a><a href="/x" data-swap="replace:1st">x</a>${LIST}`,
      ),
    )
    expect(codes(findings)).toEqual(["NF-C049", "NF-C049", "NF-C049", "NF-C049"])
    expect(findings.map((f) => f.message.split(":")[0])).toEqual([
      "data-swap on <button> never swaps",
      "data-swap on an <a> without href never swaps",
      'data-swap="swap',
      'data-swap="replace',
    ])
  })

  test("flags data-swap in JSX, which no page can answer", async () => {
    const findings = await scan({
      file: "routes/list.tsx",
      content: 'export default () => <a href="/list" data-swap="replace:results">More</a>',
    })
    expect(codes(findings)).toEqual(["NF-C049"])
    expect(findings[0]?.message).toContain("only a @nifrajs/web-vanilla page answers")
  })

  test("names the line of its tag, past an interpolation that spans lines", async () => {
    const content = [
      'import { html } from "@nifrajs/web-vanilla"',
      "export default () => html`<main>",
      `  \${[`,
      "    1,",
      "  ]}",
      '  <div data-swap="replace:x">y</div>',
      "</main>`",
    ].join("\n")
    const findings = await scan({ file: "routes/a.tsx", content })
    expect(findings.filter((f) => f.code === "NF-C049").map((f) => f.line)).toEqual([6])
  })

  test("does not judge an interpolated value", async () => {
    const markup = `<a href="/x" data-swap="\${mode}:results">x</a>${LIST}`
    expect(codes(await scan(page("routes/hotels.tsx", markup)))).toEqual([])
  })
})

describe("NF-C050 swap names a slot nothing declares", () => {
  test("flags a slot name no data-swap-slot declares, in any file", async () => {
    const findings = await scan(
      page("routes/hotels.tsx", `<a href="/hotels" data-swap="replace:reslts">x</a>${LIST}`),
    )
    expect(codes(findings)).toEqual(["NF-C050"])
    expect(findings[0]?.message).toContain('names slot "reslts"')
  })

  test("a slot in another file counts, and a computed slot name stops the judging", async () => {
    const layout = page(
      "routes/_layout.tsx",
      `<aside data-swap-slot="cart">\${slot("cart", rows)}</aside>`,
    )
    const link = page("routes/hotels.tsx", '<a href="/hotels" data-swap="replace:cart">x</a>')
    expect(codes(await scan(layout, link))).toEqual([])
    const computed = page("routes/a.tsx", `<div data-swap-slot="\${name}"></div>`, "html")
    const missing = page("routes/hotels.tsx", '<a href="/hotels" data-swap="replace:nope">x</a>')
    expect(codes(await scan(computed, missing))).not.toContain("NF-C050")
  })
})

describe("NF-C051 slot content is not its slot() alone", () => {
  test("flags content beside slot(), a slot with none, and slot() of another name", async () => {
    const findings = await scan(
      page(
        "routes/a.tsx",
        `<ul data-swap-slot="a"><h2>Title</h2>\${slot("a", rows)}</ul><ul data-swap-slot="b"><li>static</li></ul><ul data-swap-slot="c">\${slot("d", rows)}</ul>`,
      ),
    )
    expect(codes(findings)).toEqual(["NF-C051", "NF-C051", "NF-C051"])
    expect(findings.map((f) => f.evidence?.[0])).toEqual([
      'data-swap-slot="a"',
      'data-swap-slot="b"',
      'data-swap-slot="c"',
    ])
  })

  test("flags slot() outside a slot element, a second slot of a name and a bad name", async () => {
    const findings = await scan(
      page(
        "routes/a.tsx",
        `${LIST}<ul data-swap-slot="results">\${slot("results", rows)}</ul><p>\${slot("p", rows)}</p><div data-swap-slot="x y">\${slot("x y", rows)}</div>`,
      ),
    )
    expect(findings.map((f) => f.message.slice(0, 40))).toEqual([
      'a second data-swap-slot="results" in thi',
      'data-swap-slot="x y" is never swapped: a',
      'slot("p", ...) is not the content of a d',
    ])
  })

  test("a component call as the slot's content, or a slot() rendered elsewhere, is not judged", async () => {
    const markup = `<ul data-swap-slot="results">\${Rows(rows)}</ul>`
    const rows = {
      file: "routes/rows.ts",
      content: [
        'import { slot } from "@nifrajs/web-vanilla"',
        'export const Rows = (rows: string[]) => slot("results", rows)',
      ].join("\n"),
    }
    expect(codes(await scan(page("routes/a.tsx", markup), rows))).toEqual([])
  })

  test("a slot() of another package is not this one", async () => {
    const other = {
      file: "routes/a.tsx",
      content: [
        'import { html } from "@nifrajs/web-vanilla"',
        'import { slot } from "./slots.ts"',
        `export default () => html\`<p>\${slot("x", 1)}</p>\``,
      ].join("\n"),
    }
    expect(codes(await scan(other))).toEqual([])
  })
})

describe("NF-C052 swap URL's page renders no such slot", () => {
  const hotels = page("routes/hotels.tsx", LIST)

  test("flags a link to a page whose module and layouts render no such slot", async () => {
    const about = page("routes/about.tsx", '<a href="/hotels?q=x" data-swap="replace:cart">x</a>')
    const findings = await scan(
      hotels,
      about,
      page("routes/_layout.tsx", `<aside data-swap-slot="cart">\${slot("cart", rows)}</aside>`),
      page("routes/other/x.tsx", '<a href="/hotels" data-swap="replace:results">x</a>'),
    )
    expect(codes(findings)).toEqual([])
    const away = page("routes/about.tsx", '<a href="/about" data-swap="replace:results">x</a>')
    const flagged = await scan(hotels, away)
    expect(codes(flagged)).toEqual(["NF-C052"])
    expect(flagged[0]?.message).toContain("goes to /about")
  })

  test("a query-only or missing URL is the page's own, and an interpolated query is judged by its path", async () => {
    const self = page(
      "routes/hotels.tsx",
      `<form data-swap="replace:results"></form><a href="?page=\${2}" data-swap="append:results">More</a>${LIST}`,
    )
    expect(codes(await scan(self))).toEqual([])
    const elsewhere = page(
      "routes/list.tsx",
      `<a href="/list?page=\${2}" data-swap="append:results">More</a><a href="?p=1" data-swap="append:results">More</a>`,
    )
    expect(codes(await scan(hotels, elsewhere))).toEqual(["NF-C052", "NF-C052"])
  })

  test("follows the page's local imports, and stops judging at one it cannot follow", async () => {
    const rows = {
      file: "routes/parts/rows.ts",
      content: [
        'import { html, slot } from "@nifrajs/web-vanilla"',
        `export const Results = () => html\`<ul data-swap-slot="results">\${slot("results", [])}</ul>\``,
      ].join("\n"),
    }
    const list = {
      file: "routes/list.tsx",
      content: [
        'import { html } from "@nifrajs/web-vanilla"',
        'import "./list.css"',
        'import { Results } from "./parts/rows"',
        `export default () => html\`<a href="/list?page=2" data-swap="append:results">More</a>\${Results()}\``,
      ].join("\n"),
    }
    expect(codes(await scan(list, rows))).toEqual([])
    const dotted = {
      file: "routes/list.tsx",
      content: [
        'import { html } from "@nifrajs/web-vanilla"',
        'import { Results } from "./parts/rows.view"',
        `export default () => html\`<a href="/list?page=2" data-swap="append:results">More</a>\${Results()}\``,
      ].join("\n"),
    }
    expect(codes(await scan(dotted, { ...rows, file: "routes/parts/rows.view.ts" }))).toEqual([])
    const aliased = {
      file: "routes/list.tsx",
      content: [
        'import { html } from "@nifrajs/web-vanilla"',
        'import { Results } from "~/parts/rows"',
        `export default () => html\`<a href="/list" data-swap="append:results">More</a>\${Results()}\``,
      ].join("\n"),
    }
    expect(codes(await scan(aliased, rows))).toEqual([])
  })
})

describe("NF-C048 bindings inside a slot", () => {
  const client = {
    file: "routes/cart.client.ts",
    content: [
      'import { bindIsland } from "@nifrajs/web/islands"',
      'import { enableSwap } from "@nifrajs/web/islands/swap"',
      'const cart = bindIsland(({ state }) => { state("count", 0); return {} })',
      "enableSwap({ cart })",
    ].join("\n"),
  }

  test("flags an outer island's binding inside a slot, not one from an island in the slot", async () => {
    const outer = page(
      "routes/cart.tsx",
      `<div data-island="cart"><ul data-swap-slot="rows">\${slot("rows", html\`<b data-bind-text="count"></b>\`)}</ul><p data-swap-slot="p"><i data-bind-text="count"></i></p></div>`,
    )
    const findings = await scan(client, outer)
    expect(codes(findings)).toEqual(["NF-C048", "NF-C051"])
    expect(findings.find((f) => f.code === "NF-C048")?.message).toContain(
      'sits in data-swap-slot "p" but belongs to an island outside it',
    )
    const inner = page(
      "routes/cart.tsx",
      '<ul data-swap-slot="rows"><li data-island="cart"><b data-bind-text="count"></b></li></ul>',
    )
    expect(codes(await scan(client, inner))).toEqual(["NF-C051"])
  })

  test("an island mounted by enableSwap is judged like one mounted by mountIslands", async () => {
    const markup = '<div data-island="cart"><b data-bind-text="cuont"></b></div>'
    expect(codes(await scan(client, page("routes/cart.tsx", markup)))).toEqual(["NF-C047"])
  })
})

test("each swap code explains itself", async () => {
  for (const code of ["NF-C049", "NF-C050", "NF-C051", "NF-C052"]) {
    const out = await explainRule(code)
    expect(out.code).toBe(code)
    if (out.code === code && "docs" in out) expect(out.docs).toEndWith("/docs/islands")
  }
})
