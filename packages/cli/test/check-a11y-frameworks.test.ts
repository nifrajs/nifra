import { afterEach, beforeEach, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

// One catalog of cases, written in the markup of each of the five frameworks. A finding has to come
// out the same whichever one wrote the element: the rule judges markup, not a framework.

type Framework = "react" | "preact" | "solid" | "svelte" | "vue"
const FRAMEWORKS: readonly Framework[] = ["react", "preact", "solid", "svelte", "vue"]
const VOID = new Set(["img", "input", "area", "hr"])

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-a11y-frameworks-")
})
afterEach(() => removeFixtureRoot(root))

const isJsx = (framework: Framework): boolean =>
  framework === "react" || framework === "preact" || framework === "solid"

/** An element in the framework's syntax, from attributes written the same in all five. */
function element(framework: Framework, tag: string, attributes = ""): string {
  const open = `<${tag}${attributes === "" ? "" : ` ${attributes}`}`
  if (isJsx(framework)) return `${open} />`
  return VOID.has(tag) ? `${open}>` : `${open}></${tag}>`
}

/** An attribute whose value the framework builds at run time. */
function bound(framework: Framework, name: string): string {
  if (framework === "svelte") return `${name}={x}`
  if (framework === "vue") return `:${name}="x"`
  return `${name}={props.x}`
}

const spread = (framework: Framework): string =>
  framework === "svelte" ? "{...rest}" : framework === "vue" ? 'v-bind="rest"' : "{...props}"

/** An event handler or directive: not an attribute, and no reason to read the element differently. */
function handler(framework: Framework): string {
  if (framework === "svelte") return "on:click={() => {}} use:action"
  if (framework === "vue") return '@click="go" v-if="x"'
  if (framework === "solid") return "onClick={() => {}} classList={{ a: true }}"
  return "onClick={() => {}}"
}

/** An element rendered once for each item, the way the framework loops. */
function looped(framework: Framework): string {
  if (framework === "svelte") return "{#each items as item}<img src={item}>{/each}"
  if (framework === "vue") return '<img v-for="item in items" :src="item">'
  if (framework === "solid") return "<For each={props.items}>{(item) => <img src={item} />}</For>"
  return "props.items.map((item) => <img key={item} src={item} />)"
}

interface Case {
  readonly name: string
  readonly markup: (framework: Framework) => string
  readonly kind: string | undefined
  readonly only?: (framework: Framework) => boolean
}

const plain = (
  tag: string,
  attributes: string,
  kind: string | undefined,
  name = attributes,
): Case => ({
  name,
  markup: (framework) => element(framework, tag, attributes),
  kind,
})

const CASES: readonly Case[] = [
  plain("p", 'role="buttn"', "invalid-role"),
  plain("p", 'role="widget"', "abstract-role"),
  plain("p", 'aria-labeledby="a"', "unknown-aria"),
  plain("p", 'aria-hidden="yes"', "invalid-aria-value"),
  plain("p", 'role="checkbox"', "missing-required"),
  plain("img", 'src="/a.png"', "img-alt"),
  plain("p", 'tabindex="3"', "tabindex"),
  plain("button", 'role="button"', "redundant-role"),
  plain("div", 'role="button" tabindex="0"', "native-element"),
  plain("p", 'role="checkbox" aria-checked="true"', undefined),
  plain("img", 'src="/a.png" alt=""', undefined),
  plain("img", 'src="/a.png" alt="A chart"', undefined),
  plain("input", 'type="checkbox" role="checkbox"', undefined),
  plain("Card", 'role="buttn" aria-labeledby="a"', undefined, "a component"),
  {
    name: "a bound role",
    markup: (framework) => element(framework, "p", bound(framework, "role")),
    kind: undefined,
  },
  {
    name: "a bound aria-checked satisfies the role",
    markup: (framework) =>
      element(framework, "p", `role="checkbox" ${bound(framework, "aria-checked")}`),
    kind: undefined,
  },
  {
    name: "a spread",
    markup: (framework) => element(framework, "p", `role="buttn" ${spread(framework)}`),
    kind: undefined,
  },
  {
    name: "a handler or directive beside a bad role",
    markup: (framework) => element(framework, "p", `${handler(framework)} role="buttn"`),
    kind: "invalid-role",
  },
  {
    name: "an element a loop renders",
    markup: looped,
    kind: "img-alt",
  },
  {
    name: "an unquoted value",
    markup: (framework) => element(framework, "p", "role=checkbox aria-checked=true tabindex=0"),
    kind: undefined,
    only: (framework) => !isJsx(framework),
  },
  {
    name: "an unquoted bad value",
    markup: (framework) => element(framework, "p", "role=buttn"),
    kind: "invalid-role",
    only: (framework) => !isJsx(framework),
  },
  {
    name: "an expression inside an attribute value",
    markup: (framework) =>
      element(
        framework,
        "img",
        framework === "svelte" ? 'src="/a.png" alt="{x} photo"' : 'src="/a.png" alt="photo"',
      ),
    kind: undefined,
  },
]

/** The file for a framework, and the line its first case is on. */
function write(framework: Framework, lines: readonly string[]): number {
  if (isJsx(framework)) {
    const head = [
      "export default function Page(props: { x: string; items: string[] }) {",
      "  return [",
    ]
    writeAppFile(
      root,
      "routes/index.tsx",
      `${[...head, ...lines.map((line) => `    ${line},`), "  ]", "}"].join("\n")}\n`,
    )
    return head.length + 1
  }
  if (framework === "svelte") {
    const head = [
      '<script lang="ts">',
      '  export let x = ""',
      "  export let items: string[] = []",
      "  export let rest: Record<string, string> = {}",
      "</script>",
    ]
    writeAppFile(root, "routes/index.svelte", `${[...head, ...lines].join("\n")}\n`)
    return head.length + 1
  }
  const head = [
    '<script setup lang="ts">',
    'const x = "a"',
    "const items: string[] = []",
    "const rest = {}",
    "</script>",
    "<template>",
    "  <section>",
  ]
  writeAppFile(
    root,
    "routes/index.vue",
    `${[...head, ...lines.map((line) => `    ${line}`), "  </section>", "</template>"].join("\n")}\n`,
  )
  return head.length + 1
}

async function findings(): Promise<Array<{ line: number; kind: string; code: string }>> {
  const result = await collectCheckResult(root, { lintsOnly: true })
  return result.diagnostics
    .filter((found) => found.code === "NF-C062" || found.code === "NF-C063")
    .map((found) => ({
      line: found.line ?? 0,
      code: found.code ?? "",
      kind: (found.evidence?.[0] ?? "").replace("kind: ", ""),
    }))
    .sort((a, b) => a.line - b.line)
}

for (const framework of FRAMEWORKS) {
  test(`${framework}: every case in the catalog reports what the markup says`, async () => {
    const cases = CASES.filter((one) => one.only === undefined || one.only(framework))
    const first = write(
      framework,
      cases.map((one) => one.markup(framework)),
    )
    const expected = cases.flatMap((one, index) =>
      one.kind === undefined ? [] : [{ line: first + index, kind: one.kind }],
    )
    const found = await findings()
    expect(found.map(({ line, kind }) => ({ line, kind }))).toEqual(expected)
    const codes = new Set(found.map((one) => `${one.kind} ${one.code}`))
    expect(codes.has("invalid-role NF-C062")).toBe(true)
    expect(codes.has("img-alt NF-C063")).toBe(true)
  })
}

test("the five frameworks agree on the findings, in count and in kind", async () => {
  const kinds = new Map<Framework, string>()
  for (const framework of FRAMEWORKS) {
    removeFixtureRoot(root)
    root = createFixtureRoot("tmp-check-a11y-frameworks-")
    const cases = CASES.filter((one) => one.only === undefined || one.only(framework))
    write(
      framework,
      cases.map((one) => one.markup(framework)),
    )
    kinds.set(
      framework,
      (await findings())
        .map((one) => one.kind)
        .sort()
        .join(","),
    )
  }
  // The unquoted cases exist only where a template is not JSX, so those two add one finding.
  const jsx = kinds.get("react")
  expect(kinds.get("preact")).toBe(jsx)
  expect(kinds.get("solid")).toBe(jsx)
  expect(kinds.get("svelte")).toBe(kinds.get("vue"))
  expect(kinds.get("svelte")?.split(",").length).toBe((jsx?.split(",").length ?? 0) + 1)
})

test("a Svelte file judges its markup and not its script, its style or its comments", async () => {
  writeAppFile(
    root,
    "routes/index.svelte",
    `<script lang="ts">
  const html = '<img src="/a.png"> <p role="buttn">'
  export let items: string[] = []
</script>

<!-- <img src="/commented.png"> -->
{#if items.length > 0}
  <ul>
    {#each items as item}
      <li><img src={item}></li>
    {/each}
  </ul>
{:else}
  <p role="nonsense">none</p>
{/if}
<style>
  img[role="buttn"] { color: red }
</style>
`,
  )
  const found = await findings()
  expect(found.map((one) => `${one.line} ${one.kind}`)).toEqual(["10 img-alt", "14 invalid-role"])
})

test("a Vue file judges the markup of its template, and not its script or interpolations", async () => {
  writeAppFile(
    root,
    "routes/index.vue",
    `<script setup lang="ts">
const html = '<img src="/a.png"> <p role="buttn">'
const items: string[] = []
</script>

<template>
  <ul>
    <!-- <img src="/commented.png"> -->
    <li v-for="item in items"><img :src="item"></li>
    <li>{{ '<img src="/shown.png">' }}</li>
    <template #footer><p role="nonsense">none</p></template>
  </ul>
</template>

<style scoped>
img[role="buttn"] { color: red }
</style>
`,
  )
  const found = await findings()
  expect(found.map((one) => `${one.line} ${one.kind}`)).toEqual(["9 img-alt", "11 invalid-role"])
})

test("a nifra-expect HTML comment accepts a template finding only when it gives a reason", async () => {
  const marked = `
<!-- nifra-expect NF-C063: the artwork is decoration, described by the caption -->
<img src="/a.png">
<!-- nifra-expect a11y: a legacy control kept until the redesign -->
<div
  role="button"
  tabindex="0"
></div>
<!-- nifra-expect NF-C063 -->
<img src="/b.png">
<!-- nifra-expect NF-C063: wrong code for this one -->
<p role="nonsense"></p>
<img src="/c.png"> <!-- nifra-expect NF-C063: trailing -->
<p>nifra-expect NF-C063: <img src="/d.png"></p>
`
  writeAppFile(root, "routes/index.svelte", marked)
  writeAppFile(root, "routes/other.vue", `<template>\n<div>${marked}</div>\n</template>\n`)
  const found = await findings()
  // Each file holds the same marked lines, the Vue one a line lower for the `<div>` it opens.
  expect(found.map((one) => `${one.line} ${one.kind}`)).toEqual([
    "10 img-alt",
    "11 img-alt",
    "12 invalid-role",
    "13 invalid-role",
    "14 img-alt",
    "15 img-alt",
  ])
  expect(found.filter((one) => one.line === 10 || one.line === 11)).toHaveLength(2)
})

test("a test directory's templates are left alone", async () => {
  writeAppFile(root, "test/fixtures/widget.vue", '<template><img src="/a.png"></template>\n')
  writeAppFile(root, "test/fixtures/widget.svelte", '<img src="/a.png">\n')
  expect(await findings()).toEqual([])
})
