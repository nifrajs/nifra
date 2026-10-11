import { afterAll, describe, expect, test } from "bun:test"
import { relative } from "node:path"
import { collectCheckResult, componentScripts, walkSource } from "../src/check.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

const parent = createFixtureRoot("tmp-check-scripts-")
afterAll(() => removeFixtureRoot(parent))

function project(files: Record<string, string>): string {
  const root = createFixtureProject(parent, "app-")
  for (const [path, content] of Object.entries(files)) writeAppFile(root, path, content)
  return root
}

const KEY = "sk_live_51HcQ2eLkdIwHu7ixA9bC0dEfGhIjKlMnOpQr"

async function findings(root: string): Promise<string[]> {
  const result = await collectCheckResult(root, { lintsOnly: true })
  const seen = new Set<string>()
  for (const d of [...result.diagnostics, ...(result.structuredDiagnostics ?? [])])
    if (d.code !== undefined && /^NF-C0(04|29|32)$/.test(d.code))
      seen.add(`${d.code} ${d.file}:${d.line}`)
  return [...seen].sort()
}

describe("nifra check reads every file a build loads", () => {
  test("JSX, JavaScript, Svelte and Vue routes get the rules a TypeScript route gets", async () => {
    const root = project({
      "nifra.config.ts": "export const adapter = {}\n",
      "backend/db.ts": 'import pg from "pg"\nexport const pool = new pg.Pool()\n',
      "routes/about.jsx": [
        'import pg from "pg"',
        `const key = "${KEY}"`,
        "export default function About() { return process.env.DATABASE_URL + key + pg }",
        "",
      ].join("\n"),
      "routes/plain.js": 'import { pool } from "../backend/db"\nexport default () => pool\n',
      "routes/index.svelte": [
        '<script lang="ts">',
        '  import { pool } from "../backend/db"',
        `  const key = "${KEY}"`,
        "</script>",
        "<p>{key}{pool}{process.env.DATABASE_URL}</p>",
        "",
      ].join("\n"),
      "routes/page.vue": [
        "<template><p>{{ key }}</p></template>",
        "<script setup>",
        'import pg from "pg"',
        `const key = "${KEY}" + pg`,
        "</script>",
        "",
      ].join("\n"),
    })
    expect(await findings(root)).toEqual([
      "NF-C004 routes/about.jsx:1",
      "NF-C004 routes/index.svelte:2",
      "NF-C004 routes/page.vue:3",
      "NF-C004 routes/plain.js:1",
      "NF-C029 routes/about.jsx:3",
      "NF-C029 routes/index.svelte:5",
      "NF-C032 routes/about.jsx:2",
      "NF-C032 routes/index.svelte:3",
      "NF-C032 routes/page.vue:4",
    ])
  })

  test("a JavaScript file outside a zone is tooling and is not scanned", async () => {
    const root = project({
      "tailwind.config.js": "export default {}\n",
      "scripts/seed.mjs": "export {}\n",
      "routes/a.js": "export default 1\n",
      "frontend/b.cjs": "module.exports = 1\n",
      "lib/c.frontend.js": "export default 1\n",
      "components/Card.svelte": "<p>card</p>\n",
      "components/Card.jsx": "export default () => null\n",
      "server.ts": "export {}\n",
    })
    const plain: string[] = []
    await walkSource(root, (rel) => plain.push(rel))
    expect(plain).toEqual(["server.ts"])
    const visited: string[] = []
    await walkSource(root, (rel) => visited.push(rel), { scripts: true })
    expect(visited).toEqual([
      "components/Card.jsx",
      "components/Card.svelte",
      "frontend/b.cjs",
      "lib/c.frontend.js",
      "routes/a.js",
      "server.ts",
    ])
  })
})

describe("zone rules follow every way a file is zoned", () => {
  test("a configured zone folder and a zone suffix outside the zone folders are browser code", async () => {
    const root = project({
      "package.json": JSON.stringify({
        name: "app",
        dependencies: { "@nifrajs/web": "*" },
        nifra: { zones: { frontend: ["components"] } },
      }),
      "nifra.config.ts": "export const adapter = {}\n",
      "components/keys.ts": `export const key = "${KEY}"\nexport const url = process.env.DATABASE_URL\n`,
      "lib/api.frontend.ts": `export const key = "${KEY}"\nexport const url = process.env.DATABASE_URL\n`,
      "lib/server-side.ts": `export const key = "${KEY}"\nexport const url = process.env.DATABASE_URL\n`,
      "routes/index.tsx":
        'import { key } from "../components/keys"\nimport { url } from "../lib/api.frontend"\nexport default () => key + url\n',
    })
    expect(await findings(root)).toEqual([
      "NF-C029 components/keys.ts:2",
      "NF-C029 lib/api.frontend.ts:2",
      "NF-C032 components/keys.ts:1",
      "NF-C032 lib/api.frontend.ts:1",
    ])
  })

  test("a relative project root is read like an absolute one", async () => {
    const root = project({
      "nifra.config.ts": "export const adapter = {}\n",
      "frontend/keys.ts": `export const key = "${KEY}"\n`,
    })
    const relativeRoot = relative(process.cwd(), root)
    expect(relativeRoot.startsWith("/")).toBe(false)
    expect(await findings(relativeRoot)).toEqual(["NF-C032 frontend/keys.ts:1"])
  })
})

describe("componentScripts", () => {
  test("keeps script blocks in place and blanks the rest, line for line", () => {
    const source = '<p>{x}</p>\n<script lang="ts">\nconst x = 1\n</script>\n<b>y</b>'
    const scripts = componentScripts(source)
    expect(scripts).toHaveLength(source.length)
    expect(scripts.split("\n")).toEqual([
      "          ",
      "                  ",
      "const x = 1",
      "         ",
      "        ",
    ])
  })

  test("reads every script block, an unclosed one to the end, and skips other elements", () => {
    expect(componentScripts("<scripts>a</scripts><script>b</script><script>c")).toBe(
      `${" ".repeat(28)}b${" ".repeat(17)}c`,
    )
    expect(componentScripts("<script")).toBe("       ")
  })
})
