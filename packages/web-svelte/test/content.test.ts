import { expect, test } from "bun:test"
import { unlinkSync } from "node:fs"
import { join } from "node:path"
import { render } from "svelte/server"
import { svelteBunPlugin } from "../src/plugin.ts"

const SVELTE_EXTERNALS = [
  "svelte",
  "svelte/internal/server",
  "svelte/internal/client",
  "svelte/internal/disclose-version",
  "esm-env",
]

// Content.svelte is a `.svelte` file, so compile it (svelteBunPlugin "ssr") before importing + rendering.
test("Content.svelte injects raw HTML via {@html} (not escaped)", async () => {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "src", "Content.svelte")],
    plugins: [svelteBunPlugin("ssr")],
    target: "bun",
    external: SVELTE_EXTERNALS,
  })
  expect(built.success).toBe(true)
  const out = join(import.meta.dir, "__content_out.mjs")
  await Bun.write(out, await built.outputs[0]!.text())
  try {
    const Content = (await import(out)).default
    const result = render(Content, { props: { html: "<em>raw &amp; real</em>" } })
    expect(result.body).toContain("<em>raw &amp; real</em>")
    expect(result.body).toContain("<div") // default wrapper element
  } finally {
    unlinkSync(out)
  }
})
