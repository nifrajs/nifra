import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildClient } from "@nifrajs/web/build"
import { svelteBunPlugin } from "../src/plugin.ts"

// The zone rules hold for Svelte routes exactly as for TSX ones: what the client build refuses, and
// that a correctly split route builds. Inside the package so `svelte` and `@nifrajs/web` resolve.
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
    clientModule: "@nifrajs/web-svelte/client",
    plugins: [svelteBunPlugin("dom")],
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

test("a loader in the page's module script is refused, naming its backend half", async () => {
  write({
    "routes/index.svelte":
      "<script module>\n  export async function loader() { return { n: 1 } }\n</script>\n<p>hi</p>\n",
  })
  expect(await refusal()).toContain(
    '"routes/index.svelte" exports "loader", which runs on the server only. Move it to "routes/index.backend.ts"',
  )
}, 60_000)

test("a page importing backend code is refused with the chain", async () => {
  write({
    "backend/db.ts": "export const rows = () => []\n",
    "routes/index.svelte":
      '<script>\n  import { rows } from "../backend/db.ts"\n</script>\n<p>{rows().length}</p>\n',
  })
  const message = await refusal()
  expect(message).toContain("backend/db.ts: it is backend code")
  expect(message).toContain("routes/index.svelte")
}, 60_000)

test("a page reading a private variable in markup is refused", async () => {
  write({ "routes/index.svelte": "<p>{process.env.SESSION_SECRET}</p>\n" })
  expect(await refusal()).toContain(
    "routes/index.svelte: it reads private environment variable process.env.SESSION_SECRET",
  )
}, 60_000)

test("a split route builds: the page, its backend half and shared code", async () => {
  write({
    "shared/format.ts": 'export const format = (n: number) => "#" + String(n)\n',
    "routes/index.backend.ts":
      'import { format } from "../shared/format.ts"\nexport const loader = () => ({ label: format(1) })\n',
    "routes/index.svelte":
      '<script>\n  import { format } from "../shared/format.ts"\n  let { data } = $props()\n</script>\n<p>{data.label} {format(2)}</p>\n',
  })
  const manifest = await build()
  expect(manifest.entry).toStartWith("/")
}, 60_000)
