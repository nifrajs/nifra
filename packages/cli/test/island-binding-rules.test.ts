import { describe, expect, test } from "bun:test"
import { explainRule } from "../src/rule-explain.ts"
import { runRuleRegistry, sourceIndex } from "../src/rules/index.ts"
import { islandRules } from "../src/rules/islands.ts"
import { projectFacts } from "./rule-facts.ts"

async function scan(...files: Array<{ file: string; content: string }>) {
  const facts = { ...projectFacts("app/x.ts", ""), source: sourceIndex(files) }
  return runRuleRegistry(
    { root: process.cwd(), sources: facts.source, project: facts },
    islandRules,
  )
}
const codes = (findings: readonly { code: string }[]) => findings.map((f) => f.code).sort()

const CLIENT = {
  file: "routes/cart.client.ts",
  content: [
    'import { bindIsland, mountIslands } from "@nifrajs/web/islands"',
    "const cart = bindIsland(({ state }) => {",
    '  const count = state("count", 0)',
    '  state("open", false)',
    "  return { add: () => count.set((n) => n + 1), toggle: () => {} }",
    "})",
    "mountIslands({ cart })",
  ].join("\n"),
}
const page = (markup: string) => ({
  file: "routes/cart.tsx",
  content: [
    'import { html } from "@nifrajs/web-vanilla"',
    `export default () => html\`${markup}\``,
  ].join("\n"),
})

describe("NF-C022 bindList key", () => {
  const list = (key: string) => ({
    file: "app/todo.client.ts",
    content: [
      'import { bindList, signal } from "@nifrajs/web/islands"',
      "const items = signal([])",
      `bindList(items, document.body, { key: ${key}, create: () => document.createElement("li") })`,
    ].join("\n"),
  })

  test("flags a key that takes a position parameter bindList never passes", async () => {
    expect(codes(await scan(list("(item, i) => i")))).toEqual(["NF-C022"])
    expect(codes(await scan(list("function (item, i) { return item.id + i }")))).toEqual([
      "NF-C022",
    ])
  })

  test("flags a key computed from the item's position in the array", async () => {
    expect(codes(await scan(list("(item) => items().indexOf(item)")))).toEqual(["NF-C022"])
    expect(codes(await scan(list("(item) => items().findIndex((x) => x === item)")))).toEqual([
      "NF-C022",
    ])
    expect(
      codes(await scan(list("({ id }) => items().findLastIndex((x) => x.id === id)"))),
    ).toEqual(["NF-C022"])
  })

  test("flags a destructured second parameter, which throws on the undefined bindList passes", async () => {
    expect(codes(await scan(list("(item, { at }) => item.id")))).toEqual(["NF-C022"])
  })

  test("does not flag a stable id key", async () => {
    expect(codes(await scan(list("(item) => item.id")))).toEqual([])
    expect(codes(await scan(list("keyOf")))).toEqual([])
    expect(codes(await scan(list("() => crypto.randomUUID()")))).toEqual([])
  })

  test("does not flag an indexOf over the item's own data, or a second parameter it never reads", async () => {
    expect(codes(await scan(list('(u) => u.email.slice(0, u.email.indexOf("@"))')))).toEqual([])
    expect(codes(await scan(list("(item) => items().indexOf(other.item)")))).toEqual([])
    expect(codes(await scan(list("(item, _i) => item.id")))).toEqual([])
  })
})

describe("NF-C047 island binding names", () => {
  test("names that the setup declares and returns pass", async () => {
    const markup =
      '<div data-island="cart"><b data-bind-text="count"></b><p data-bind-show="open"></p><button data-bind-on="click:add, keyup:toggle" data-bind-class="on:open" data-bind-attr="aria-expanded:open"></button></div>'
    expect(codes(await scan(CLIENT, page(markup)))).toEqual([])
  })

  test("flags a signal name the setup never declares", async () => {
    const findings = await scan(
      CLIENT,
      page('<div data-island="cart"><b data-bind-text="cuont"></b></div>'),
    )
    expect(codes(findings)).toEqual(["NF-C047"])
    expect(findings[0]?.message).toContain('"cuont"')
    expect(findings[0]?.file).toBe("routes/cart.tsx")
    expect(findings[0]?.severity).toBe("warn")
  })

  test("flags a handler the setup does not return, and a state key used as a handler", async () => {
    const findings = await scan(
      CLIENT,
      page('<div data-island="cart"><button data-bind-on="click:sav, input:count"></button></div>'),
    )
    expect(codes(findings)).toEqual(["NF-C047", "NF-C047"])
  })

  test("reads names through ctx.state, a renamed state and a block-body return", async () => {
    const client = {
      file: "routes/cart.client.ts",
      content: [
        'import { bindIsland, mountIslands } from "@nifrajs/web/islands"',
        "const a = bindIsland((ctx) => { ctx.state('n', 0); return undefined })",
        "const b = bindIsland(({ state: s }) => { s('m', 0); if (x) return { go() {} }; return { go: f } })",
        'mountIslands({ a, "b": b })',
      ].join("\n"),
    }
    const ok =
      '<div data-island="a"><i data-bind-text="n"></i></div><div data-island="b"><i data-bind-text="m" data-bind-on="click:go"></i></div>'
    expect(codes(await scan(client, page(ok)))).toEqual([])
    const bad =
      '<div data-island="a"><i data-bind-text="m"></i></div><div data-island="b"><i data-bind-on="click:stop"></i></div>'
    expect(codes(await scan(client, page(bad)))).toEqual(["NF-C047", "NF-C047"])
  })

  test("a binding on a nested host belongs to the outer island", async () => {
    const client = {
      file: "routes/c.client.ts",
      content: [
        'import { bindIsland, mountIslands } from "@nifrajs/web/islands"',
        'mountIslands({ outer: bindIsland(({ state }) => { state("open", true) }), inner: bindIsland(({ state }) => { state("n", 0) }) })',
      ].join("\n"),
    }
    const markup =
      '<div data-island="outer"><section data-island="inner" data-bind-show="open"><b data-bind-text="n"></b><br><img src=x></section></div>'
    expect(codes(await scan(client, page(markup)))).toEqual([])
    const swapped =
      '<div data-island="outer"><section data-island="inner" data-bind-show="n"><b data-bind-text="open"></b></section></div>'
    expect(codes(await scan(client, page(swapped)))).toEqual(["NF-C047", "NF-C047"])
  })

  test("judges JSX hosts, including the Island marker", async () => {
    const jsx = {
      file: "routes/cart.tsx",
      content: [
        "export default () => (",
        '  <main><Island id="cart"><b data-bind-text="cuont" /></Island>',
        '  <div data-island={"cart"}><b data-bind-text={"count"} data-bind-on="click:add" /></div></main>',
        ")",
      ].join("\n"),
    }
    expect(codes(await scan(CLIENT, jsx))).toEqual(["NF-C047"])
  })

  test("stays silent when a name cannot be judged", async () => {
    const dynamic = {
      file: "routes/d.client.ts",
      content: [
        'import { bindIsland, mountIslands } from "@nifrajs/web/islands"',
        "const keys = ['a']",
        "const d = bindIsland(({ state }) => { for (const k of keys) state(k, 0); return { ...shared } })",
        "const e = bindIsland(setup)",
        "mountIslands({ d, e, f: imported })",
      ].join("\n"),
    }
    const markup =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the generated page interpolates these, so the host id and the name are not literal
      '<div data-island="d"><b data-bind-text="zz" data-bind-on="click:yy"></b></div><div data-island="e"><b data-bind-text="zz"></b></div><div data-island="f"><b data-bind-text="zz"></b></div><div data-island="${id}"><b data-bind-text="zz"></b></div><div data-island="cart"><b data-bind-text="${name}"></b></div><div data-island="nowhere"><b data-bind-text="zz"></b></div>'
    expect(codes(await scan(CLIENT, dynamic, page(markup)))).toEqual([])
  })

  test("an id mounted twice with different enhancers is not judged", async () => {
    const other = {
      file: "routes/other.client.ts",
      content: [
        'import { bindIsland, mountIslands } from "@nifrajs/web/islands"',
        'mountIslands({ cart: bindIsland(({ state }) => { state("other", 0) }) })',
      ].join("\n"),
    }
    expect(
      codes(
        await scan(
          CLIENT,
          other,
          page('<div data-island="cart"><b data-bind-text="other"></b></div>'),
        ),
      ),
    ).toEqual([])
  })
})

describe("NF-C048 island binding host", () => {
  test("flags a binding outside every host in markup that has one", async () => {
    const findings = await scan(
      CLIENT,
      page('<div data-island="cart"></div><p data-bind-text="count"></p>'),
    )
    expect(codes(findings)).toEqual(["NF-C048"])
    expect(findings[0]?.message).toContain("outside every data-island host")
  })

  test("flags a binding inside a host mounted with an imperative enhancer", async () => {
    const client = {
      file: "routes/c.client.ts",
      content: [
        'import { defineIsland, mountIslands } from "@nifrajs/web/islands"',
        "const counter = defineIsland((el) => {})",
        "mountIslands({ counter, plain: (el) => {} })",
      ].join("\n"),
    }
    const markup =
      '<div data-island="counter"><b data-bind-text="n"></b></div><div data-island="plain"><b data-bind-text="n"></b></div>'
    expect(codes(await scan(client, page(markup)))).toEqual(["NF-C048", "NF-C048"])
  })

  test("does not judge a fragment without a host of its own", async () => {
    expect(codes(await scan(CLIENT, page('<b data-bind-text="count"></b>')))).toEqual([])
  })

  test("an unclosed tag ends the scan without a finding", async () => {
    expect(
      codes(await scan(CLIENT, page('<div data-island="cart"><b data-bind-text="x"'))),
    ).toEqual([])
  })
})

describe("retired codes", () => {
  test("NF-C021 and NF-C023 explain as retired and are never reused", async () => {
    for (const code of ["NF-C021", "NF-C023"]) {
      const out = await explainRule(code)
      expect(out.code).toBe("NIFRA_UNKNOWN_RULE")
      if (out.code === "NIFRA_UNKNOWN_RULE") expect(out.message).toContain("retired")
    }
  })
})
