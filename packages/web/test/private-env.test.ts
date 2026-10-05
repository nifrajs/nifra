import { describe, expect, test } from "bun:test"
import { privateEnvReads, privateEnvReason } from "../src/internal/private-env.ts"

const reads = (file: string, source: string, prefix = "PUBLIC_") =>
  privateEnvReads(file, source, prefix)

describe("privateEnvReads", () => {
  test("every env object and access form, private names only", () => {
    const source = [
      "const a = process.env.DB_URL",
      'const b = Bun.env["TOKEN"]',
      'const c = Deno.env.get("D")',
      "const d = import.meta.env.API_KEY",
      "const e = process?.env?.OPT",
      "const { WHOLE } = process.env",
      "const f = Deno.env.toObject()",
      "const g = (1 / 2) / process.env.AFTER_DIVISION",
      `const h = \`\${process.env.IN_TEMPLATE}\``,
      "export const public_ = [process.env.PUBLIC_URL, Bun.env.NODE_ENV, import.meta.env.MODE]",
      "export const flags = [import.meta.env.DEV, import.meta.env.PROD, import.meta.env.SSR, import.meta.env.BASE_URL]",
      "",
    ].join("\n")
    expect(reads("a.ts", source)).toEqual([
      'Bun.env["TOKEN"]',
      'Deno.env.get("D")',
      "Deno.env.toObject()",
      "import.meta.env.API_KEY",
      "process.env",
      "process.env.AFTER_DIVISION",
      "process.env.DB_URL",
      "process.env.IN_TEMPLATE",
      "process.env.OPT",
    ])
  })

  test("text that only mentions a read is not one", () => {
    const source = [
      "// process.env.COMMENT",
      "/* process.env.BLOCK */",
      'const s = "process.env.STRING"',
      "const t = `process.env.TEMPLATE_TEXT`",
      "const r = /process.env.REGEX/g",
      "export default () => <p>Don't read process.env.PROSE; it's private</p>",
      "",
    ].join("\n")
    expect(reads("a.tsx", source)).toEqual([])
  })

  test("Svelte and Vue: scripts and markup expressions, never prose or styles", () => {
    expect(
      reads(
        "a.svelte",
        [
          '<script lang="ts">',
          "  const k = process.env.SCRIPT",
          "</script>",
          "<p>Don't use process.env.PROSE</p>",
          "{#if import.meta.env.DEV}{Bun.env.MARKUP}{/if}",
          "<style>.a { color: red }</style>",
          "",
        ].join("\n"),
      ),
    ).toEqual(["Bun.env.MARKUP", "process.env.SCRIPT"])
    expect(
      reads(
        "a.vue",
        '<script setup lang="ts">\nconst v = import.meta.env.SCRIPT\n</script>\n<template><p :title="process.env.ATTR">{{ process.env.MUSTACHE }} process.env.TEXT</p></template>\n',
      ),
    ).toEqual(["import.meta.env.SCRIPT", "process.env.ATTR", "process.env.MUSTACHE"])
  })

  test("a script block ends at its closing tag however that tag is spaced", () => {
    expect(
      reads("a.svelte", "<script>\nconst k = process.env.SPACED\n</script >\n<p>hi</p>\n"),
    ).toEqual(["process.env.SPACED"])
    expect(
      reads("a.vue", "<script setup>\nconst v = process.env.BROKEN\n</script\n>\n<template />\n"),
    ).toEqual(["process.env.BROKEN"])
  })

  test("MDX: ESM and expressions, never prose or code samples", () => {
    const source = [
      "export const k = process.env.ESM",
      "",
      "Prose about process.env.PROSE and `process.env.INLINE`.",
      "",
      "```ts",
      "process.env.FENCED",
      "```",
      "",
      "<Card value={process.env.EXPRESSION} />",
      "",
    ].join("\n")
    expect(reads("a.mdx", source)).toEqual(["process.env.ESM", "process.env.EXPRESSION"])
  })

  test("an empty public prefix leaves only NODE_ENV and the bundler flags public", () => {
    expect(
      reads(
        "a.ts",
        "export const x = [process.env.PUBLIC_URL, process.env.NODE_ENV, import.meta.env.DEV]\n",
        "",
      ),
    ).toEqual(["process.env.PUBLIC_URL"])
  })

  test("files that are not code are not read", () => {
    expect(reads("a.css", ".a { --x: process.env.X }")).toEqual([])
  })
})

test("privateEnvReason names the reads and what browser code may read instead", () => {
  expect(privateEnvReason(["process.env.A", "Bun.env.B"], "PUBLIC_")).toBe(
    "it reads private environment variables process.env.A, Bun.env.B. Browser code may read only NODE_ENV and variables named PUBLIC_*; read the rest in a loader, an action or under backend/",
  )
  expect(privateEnvReason(["process.env.A"], "")).toContain("may read only NODE_ENV;")
})
