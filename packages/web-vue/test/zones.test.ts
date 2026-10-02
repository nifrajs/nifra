import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildClient } from "@nifrajs/web/build"
import { vueBunPlugin } from "../src/plugin.ts"

// The zone rules hold for Vue routes exactly as for TSX ones: what the client build refuses, and
// that a correctly split route builds. Inside the package so `vue` and `@nifrajs/web` resolve.
let root: string
beforeEach(() => {
  root = mkdtempSync(`${import.meta.dir}/.tmp-zones-`)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const write = (files: Record<string, string>) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
}
const build = () =>
  buildClient({
    routesDir: join(root, "routes"),
    outDir: join(root, "dist"),
    clientModule: "@nifrajs/web-vue/client",
    plugins: [vueBunPlugin("dom")],
    conditions: ["bun", "browser"],
    publicDir: false,
    minify: false,
  })
async function refusal(): Promise<string> {
  try {
    await build()
  } catch (error) {
    const dist = join(root, "dist")
    expect(existsSync(dist) ? readdirSync(dist) : []).toEqual([])
    return (error as Error).message
  }
  throw new Error("the build passed")
}

test("a loader exported by the page is refused, naming its backend half", async () => {
  write({
    "routes/index.vue": `<script lang="ts">\nexport async function loader() { return { n: 1 } }\n</script>\n<template><p>hi</p></template>\n`,
  })
  expect(await refusal()).toContain(
    '"routes/index.vue" exports "loader", which runs on the server only. Move it to "routes/index.backend.ts"',
  )
}, 60_000)

test("a page importing backend code is refused with the chain", async () => {
  write({
    "backend/db.ts": "export const rows = () => []\n",
    "routes/index.vue": `<script setup lang="ts">\nimport { rows } from "../backend/db.ts"\n</script>\n<template><p>{{ rows().length }}</p></template>\n`,
  })
  const message = await refusal()
  expect(message).toContain("backend/db.ts: it is backend code")
  expect(message).toContain("routes/index.vue")
}, 60_000)

test("a page reading a private variable is refused", async () => {
  write({ "routes/index.vue": "<template><p>{{ process.env.SESSION_SECRET }}</p></template>\n" })
  expect(await refusal()).toContain(
    "routes/index.vue: it reads private environment variable process.env.SESSION_SECRET",
  )
}, 60_000)

test("a split route builds: the page, its backend half and shared code", async () => {
  write({
    "shared/format.ts": 'export const format = (n: number) => "#" + String(n)\n',
    "routes/index.backend.ts":
      'import { format } from "../shared/format.ts"\nexport const loader = () => ({ label: format(1) })\n',
    "routes/index.vue": `<script setup lang="ts">\nimport { format } from "../shared/format.ts"\ndefineProps<{ data: { label: string } }>()\n</script>\n<template><p>{{ data.label }} {{ format(2) }}</p></template>\n`,
  })
  const manifest = await build()
  expect(manifest.entry).toStartWith("/")
}, 60_000)
