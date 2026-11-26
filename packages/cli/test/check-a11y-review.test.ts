import { afterEach, beforeEach, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { a11yTemplateFindings } from "../src/internal/a11y-template.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-a11y-review-")
})
afterEach(() => removeFixtureRoot(root))

// One violation each, with no other markup that could let its file past the text prefilter.
const ALONE: readonly (readonly [kind: string, markup: string])[] = [
  ["invalid-role", '<p role="buttn"></p>'],
  ["unknown-aria", '<p aria-labeledby="a"></p>'],
  ["tabindex", '<p tabindex="5"></p>'],
  ["img-alt", '<img src="a.png" />'],
  ["img-alt", '<area href="/" />'],
  ["img-alt", '<input type="image" />'],
  ["html-lang", "<html><body></body></html>"],
]
const SPACINGS = ["=", " =", "= ", " = ", "\n="]

test("a file holding one violation is scanned, however its attributes are spaced", async () => {
  const expected: string[] = []
  let files = 0
  for (const [kind, markup] of ALONE) {
    for (const spacing of SPACINGS) {
      const written = markup.replace(/(role|aria-labeledby|tabindex)=/, `$1${spacing}`)
      for (const [file, source] of [
        [`routes/a${files}.tsx`, `export default () => ${written}\n`],
        [`routes/b${files}.svelte`, `${written}\n`],
        [`routes/c${files}.vue`, `<template>${written}</template>\n`],
      ] as const) {
        writeAppFile(root, file, source)
        expected.push(`${file} ${kind}`)
      }
      files++
    }
  }
  const result = await collectCheckResult(root, { lintsOnly: true })
  const found = result.diagnostics
    .filter((one) => one.code === "NF-C062" || one.code === "NF-C063")
    .map((one) => `${one.file} ${(one.evidence?.[0] ?? "").replace("kind: ", "")}`)
  expect(found.sort()).toEqual(expected.sort())
})

const kinds = (markup: string, vue = false): string[] =>
  a11yTemplateFindings(vue ? `<template>${markup}</template>` : markup, vue).findings.map(
    (found) => found.kind,
  )

test("a Svelte spread or shorthand reads the same with space inside its braces", () => {
  for (const inside of ["...props", " ...props", "\n  ...props ", "alt", " alt ", "\nalt\n"])
    expect([inside, kinds(`<img {${inside}} />`)]).toEqual([inside, []])
})

// What may stand in an expression without its braces, quotes or `>` being markup.
const OPAQUE = [
  "/[}]/.test(v)",
  "/[{]/.test(v)",
  "/\\}>/.test(v)",
  "/[/'\"`]/.test(v)",
  "v.split(/}/)",
  "ok && /}/.test(v)",
  "{ return /}/ }",
  "\n  /}/.test(v)",
  "v /* } ' */",
  "v // } '\n",
  "a / b / c",
  "(a) / 2 + n[0] / 3",
  '"/" + v',
]

test("no regex literal, comment or division in an expression hides the markup after it", () => {
  const after = '\n<img src="a.png">'
  for (const code of OPAQUE) {
    for (const markup of [
      `<button onclick={() => ${code}}>x</button>`,
      `<button onclick={${code}}>x</button>`,
      `<p>{${code}}</p>`,
      `{#if ${code}}<p></p>{/if}`,
    ])
      expect([markup, kinds(markup + after)]).toEqual([markup, ["img-alt"]])
    const mustache = `<p>{{ ${code} }}</p>`
    expect([mustache, kinds(mustache + after, true)]).toEqual([mustache, ["img-alt"]])
  }
})

test("a Svelte block closer is not the start of a regex literal", () => {
  for (const block of ["if", "each", "await", "key", "snippet"])
    expect(kinds(`{#${block} x}<p></p>{/${block}}<img src="a.png">{/${block}}`)).toEqual([
      "img-alt",
    ])
})

test("an element's own state stands in only for the attribute it supplies", () => {
  const supplied = [
    '<input type="checkbox" role="switch">',
    '<input type="CHECKBOX" role="menuitemcheckbox">',
    '<input type="radio" role="menuitemradio">',
    '<input type="range" role="slider">',
    '<input list="l" role="combobox">',
    '<input :type="kind" role="switch">',
    '<select role="combobox"></select>',
    '<option role="option"></option>',
    '<meter role="meter"></meter>',
    '<progress role="meter"></progress>',
    '<h2 role="heading"></h2>',
  ]
  for (const markup of supplied)
    expect([markup, kinds(markup).includes("missing-required")]).toEqual([markup, false])
  const missing = [
    '<input type="text" role="combobox">',
    '<input role="switch">',
    '<input type="range" role="switch">',
    '<input type="checkbox" role="slider">',
    '<textarea role="combobox"></textarea>',
    '<select role="slider"></select>',
    '<h2 role="checkbox"></h2>',
    '<span role="scrollbar" aria-valuenow="25"></span>',
  ]
  for (const markup of missing)
    expect([markup, kinds(markup).includes("missing-required")]).toEqual([markup, true])
})
