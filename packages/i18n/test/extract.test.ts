import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import ts from "typescript"
import { copyChunkId, copyChunks, createCopyScanner } from "../src/extract.ts"
import { defineLocales } from "../src/index.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "nifra-extract-")).replaceAll("\\", "/")
  roots.push(root)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(file, "utf8")
    } catch {
      return undefined
    }
  }
  return { root, scanner: createCopyScanner(ts, { root, read }) }
}

const I18N = [
  'import { defineLocales } from "@nifrajs/i18n"',
  'import { defineCopy } from "@nifrajs/i18n/copy"',
  'export const locales = defineLocales({ default: "en", locales: { en: {}, hi: {}, ta: {}, ur: { tag: "ur-PK" } } })',
  "export const copy = defineCopy(locales)",
].join("\n")

describe("createCopyScanner", () => {
  test("reads tables through imports, re-exports, namespaces and tsconfig paths", () => {
    const { root, scanner } = project({
      "tsconfig.json": '{ "compilerOptions": { "paths": { "~/*": ["./*"] } } }',
      "shared/i18n.ts": I18N,
      "lib/index.ts": 'export * from "../shared/i18n.js"',
      "lib/named.ts": 'export { copy as text } from "./index"',
      "routes/index.tsx": [
        'import { copy } from "../shared/i18n"',
        'const EN = "Saddle"',
        'export const A = copy({ en: EN, hi: "काठी", ta: "சேணம்" })',
        'export const B = copy.id("shop.faq", { en: ["a", "b"], ur: ["ا", "ب"] })',
        "export function C() {",
        "  const copy = (x: unknown) => x",
        '  return copy({ en: "a local function, not a table" })',
        "}",
        'export const D = copy({ en: "x" }), E = copy({ en: "y" })',
      ].join("\n"),
      "routes/about.tsx": [
        'import * as i18n from "~/shared/i18n"',
        'import { text } from "../lib/named"',
        'export const F = i18n.copy({ en: { title: "About", cta: "Go" } })',
        'export const G = text({ en: "via a renamed re-export" })',
      ].join("\n"),
    })
    const index = scanner.tables(`${root}/routes/index.tsx`)
    expect(index.map((t) => [t.id, t.explicit, t.callee, t.values])).toEqual([
      ["routes/index.tsx:3", false, "copy", { en: "Saddle", hi: "काठी", ta: "சேணம்" }],
      ["shop.faq", true, "copy", { en: ["a", "b"], ur: ["ا", "ب"] }],
      ["routes/index.tsx:9:18", false, "copy", { en: "x" }],
      ["routes/index.tsx:9:41", false, "copy", { en: "y" }],
    ])
    expect(index[0]?.definition).toEqual({ file: "shared/i18n.ts", name: "copy" })
    const about = scanner.tables(`${root}/routes/about.tsx`)
    expect(about.map((t) => [t.id, t.callee, t.definition.name])).toEqual([
      ["routes/about.tsx:3", "i18n.copy", "copy"],
      ["routes/about.tsx:4", "text", "copy"],
    ])
    const definition = scanner.definition({ file: "shared/i18n.ts", name: "copy" })
    expect(definition?.locales?.all).toEqual(["en", "hi", "ta", "ur"])
    expect(definition?.locales?.get("ur").tag).toBe("ur-PK")
  })

  test("a table it cannot read statically says why", () => {
    const { root, scanner } = project({
      "i18n.ts": I18N,
      "page.ts": [
        'import { copy } from "./i18n"',
        'import { EN } from "./strings"',
        "const n = 3",
        "export const a = copy({ en: EN })",
        `export const b = copy({ en: \`\${n} items\` })`,
        "export const c = copy({ ...base })",
        "export const d = copy.id(name, { en: 'x' })",
        "export const e = copy({ en: 42 })",
      ].join("\n"),
    })
    expect(scanner.tables(`${root}/page.ts`).map((t) => [t.line, t.unreadable])).toEqual([
      [4, "`EN` is imported; only constants this module declares are read"],
      [5, "a template with substitutions; a message that takes values is ICU"],
      [6, "a block with a spread, a method or an accessor"],
      [7, "the copy.id() id is not a string literal"],
      [8, "a table's values must be messages, lists and blocks of them"],
    ])
  })

  test("a registry that is not a static defineLocales config leaves its tables unsplit", () => {
    const { root, scanner } = project({
      "i18n.ts": [
        'import { defineCopy } from "@nifrajs/i18n/copy"',
        'import { load } from "./config"',
        "export const copy = defineCopy(load())",
      ].join("\n"),
      "page.ts": 'import { copy } from "./i18n"\nexport const a = copy({ en: "x" })\n',
    })
    expect(scanner.definition({ file: "i18n.ts", name: "copy" })?.unreadable).toBe(
      "the registry is not a defineLocales({...}) constant",
    )
    expect(scanner.rewrite(`${root}/page.ts`)).toBeUndefined()
  })

  test("rewrite replaces split tables with chunk ids, keeps lines, and loads first", () => {
    const page = [
      'import { copy } from "./i18n"',
      "",
      "export const A = copy({",
      '  en: "Bicycle",',
      '  ta: "மிதிவண்டி",',
      "})",
      "export const upper = copy.pick(A, 'en').toUpperCase()",
    ].join("\n")
    const { root, scanner } = project({ "i18n.ts": I18N, "page.ts": page })
    const out = scanner.rewrite(`${root}/page.ts`) ?? ""
    expect(out).not.toContain("மிதிவண்டி")
    expect(out.split("\n").slice(0, 7)).toEqual([
      'import { copy } from "./i18n"',
      "",
      `await copy.load();export const A = __nifraCopyRef("${copyChunkId("page.ts:3")}"`,
      "",
      "",
      ")",
      "export const upper = copy.pick(A, 'en').toUpperCase()",
    ])
    expect(out).toEndWith('import { copyRef as __nifraCopyRef } from "@nifrajs/i18n/copy";\n')
  })

  test("rewrite loads after a copy function the module defines itself", () => {
    const { root, scanner } = project({
      "i18n.ts": `${I18N}\nexport const TITLE = copy({ en: "Title" })\n`,
    })
    const out = scanner.rewrite(`${root}/i18n.ts`) ?? ""
    expect(out).toContain(
      "export const copy = defineCopy(locales)\nawait copy.load();export const TITLE",
    )
  })
})

describe("copyChunks", () => {
  const locales = defineLocales({ default: "en", locales: { en: {}, hi: {}, ta: {} } })
  test("each locale carries its values, or its chain's, with a fallback mark", () => {
    const chunks = copyChunks([
      { id: "a.ts:1", values: { en: "Bicycle", hi: "साइकिल", ta: "மிதிவண்டி" }, locales },
      { id: "shop.faq", values: { en: ["a"], hi: ["क"] }, locales },
    ])
    const a = copyChunkId("a.ts:1")
    const faq = copyChunkId("shop.faq")
    expect(Object.fromEntries(chunks)).toEqual({
      en: { v: { [a]: "Bicycle", [faq]: ["a"] } },
      hi: { v: { [a]: "साइकिल", [faq]: ["क"] } },
      ta: { v: { [a]: "மிதிவண்டி", [faq]: ["a"] }, f: { [faq]: ["shop.faq", "en"] } },
    })
  })

  test("two tables with one id are refused", () => {
    expect(() =>
      copyChunks([
        { id: "x", values: { en: "a" }, locales },
        { id: "x", values: { en: "b" }, locales },
      ]),
    ).toThrow('two copy tables use the id "x"')
  })
})
