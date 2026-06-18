import { expect, test } from "bun:test"
import { join } from "node:path"
import { svelteMdxBunPlugin } from "../src/mdx.ts"

const fixture = join(import.meta.dir, "fixtures", "page.mdx")
const SVELTE_EXTERNALS = [
  "svelte",
  "svelte/internal/server",
  "svelte/internal/client",
  "svelte/internal/disclose-version",
  "esm-env",
]

test("svelteMdxBunPlugin compiles .mdx → a Svelte server component (via mdsvex)", async () => {
  const built = await Bun.build({
    entrypoints: [fixture],
    plugins: [svelteMdxBunPlugin("ssr")],
    target: "bun",
    external: SVELTE_EXTERNALS,
  })
  expect(built.success).toBe(true)
  const code = await built.outputs[0]!.text()
  expect(code).toContain("svelte/internal/server") // Svelte 5 server output
  expect(code).toContain("MDX on Svelte") // the Markdown heading text
  expect(code).toContain("/docs") // the link href survives
})

test("dom mode compiles too (client build)", async () => {
  const built = await Bun.build({
    entrypoints: [fixture],
    plugins: [svelteMdxBunPlugin("dom")],
    target: "browser",
    external: SVELTE_EXTERNALS,
  })
  expect(built.success).toBe(true)
  expect(await built.outputs[0]!.text()).toContain("MDX on Svelte")
})
