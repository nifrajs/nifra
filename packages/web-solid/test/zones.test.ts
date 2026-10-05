import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildClient } from "@nifrajs/web/build"
import { solidMdxBunPlugin } from "../src/mdx.ts"
import { solidBunPlugin } from "../src/plugin.ts"

// The zone rules hold for Solid routes, TSX and MDX, through Solid's compile plugins: what the client
// build refuses, and that a correctly split route builds. Inside the package so `solid-js` resolves.
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
    clientModule: "@nifrajs/web-solid/client",
    plugins: [solidBunPlugin("dom"), solidMdxBunPlugin("dom")],
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

for (const [ext, page] of [
  ["tsx", "export async function loader() { return { n: 1 } }\nexport default () => <p>hi</p>\n"],
  ["mdx", "export async function loader() { return { n: 1 } }\n\n# hi\n"],
] as const) {
  test(`a loader exported by a .${ext} page is refused, naming its backend half`, async () => {
    write({ [`routes/index.${ext}`]: page })
    expect(await refusal()).toContain(
      `"routes/index.${ext}" exports "loader", which runs on the server only. Move it to "routes/index.backend.ts"`,
    )
  }, 60_000)
}

test("a page importing backend code is refused with the chain", async () => {
  write({
    "backend/db.ts": "export const rows = () => []\n",
    "routes/index.tsx":
      'import { rows } from "../backend/db.ts"\nexport default () => <p>{rows().length}</p>\n',
  })
  const message = await refusal()
  expect(message).toContain("backend/db.ts: it is backend code")
  expect(message).toContain("routes/index.tsx")
}, 60_000)

for (const [ext, page] of [
  ["tsx", "export default () => <p>{process.env.SESSION_SECRET}</p>\n"],
  ["mdx", "# Secret\n\n{process.env.SESSION_SECRET}\n\n```ts\nprocess.env.ONLY_A_SAMPLE\n```\n"],
] as const) {
  test(`a .${ext} page reading a private variable is refused`, async () => {
    write({ [`routes/index.${ext}`]: page })
    const message = await refusal()
    expect(message).toContain(
      `routes/index.${ext}: it reads private environment variable process.env.SESSION_SECRET`,
    )
    expect(message).not.toContain("ONLY_A_SAMPLE")
  }, 60_000)
}

test("a split route builds: the page, its backend half and shared code", async () => {
  write({
    "shared/format.ts": 'export const format = (n: number) => "#" + String(n)\n',
    "routes/index.backend.ts":
      'import { format } from "../shared/format.ts"\nexport const loader = () => ({ label: format(1) })\n',
    "routes/index.tsx":
      'import { format } from "../shared/format.ts"\nexport default (props: { data: { label: string } }) => <p>{props.data.label} {format(2)}</p>\n',
    "routes/about.mdx": 'import { format } from "../shared/format.ts"\n\n# About {format(3)}\n',
  })
  const manifest = await build()
  expect(manifest.entry).toStartWith("/")
}, 60_000)
