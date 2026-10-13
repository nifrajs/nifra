// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixtures hold template literals as module source text.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BunPlugin } from "bun"
import { buildClient } from "../src/build.ts"
import { assertNoImportGlob, expandImportGlobs } from "../src/plugins/import-glob.ts"

// Inside the workspace, so the generated bootstrap's `@nifrajs/web` imports resolve.
const ROOT = mkdtempSync(`${import.meta.dir}/.tmp-import-glob-`)
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(ROOT, "app-"))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  return dir
}

const GROVE = {
  "src/grove/oak.ts": "export default { bark: 'ridged' }\n",
  "src/grove/birch.ts": "export default { bark: 'papery' }\n",
  "src/grove/draft.ts": "export default {}\n",
  "src/grove/notes.md": "not code\n",
}

describe("expandImportGlobs", () => {
  test("a lazy glob becomes an object of loaders keyed from the importer, as Vite keys it", () => {
    const dir = app(GROVE)
    const file = join(dir, "src/load.ts")
    const out = expandImportGlobs(
      "export const loaders = import.meta.glob(['./grove/*.ts', '!./grove/draft.ts'])\n",
      file,
      dir,
    )
    expect(out).toBe(
      'export const loaders = ({"./grove/birch.ts": () => import("./grove/birch.ts"), "./grove/oak.ts": () => import("./grove/oak.ts")})\n',
    )
  })

  test("eager imports are hoisted, `import` picks an export, and a / pattern keys from the root", () => {
    const dir = app(GROVE)
    const file = join(dir, "src/deep/load.ts")
    const out = expandImportGlobs(
      "export const trees = import.meta.glob<{ bark: string }>('/src/grove/{oak,birch}.ts', { eager: true, import: 'default' })\n",
      file,
      dir,
    )
    expect(out).toBe(
      [
        'export const trees = ({"/src/grove/birch.ts": __nifra_glob_0_0["default"], "/src/grove/oak.ts": __nifra_glob_0_1["default"]})',
        "",
        'import * as __nifra_glob_0_0 from "../grove/birch.ts"',
        'import * as __nifra_glob_0_1 from "../grove/oak.ts"',
        "",
      ].join("\n"),
    )
  })

  test("a line or paragraph separator in an export name is escaped in the generated literal", () => {
    const dir = app(GROVE)
    const out = expandImportGlobs(
      "export const barks = import.meta.glob('./grove/oak.ts', { import: 'bark\u2028\u2029' })\n",
      join(dir, "src/load.ts"),
      dir,
    )
    expect(out).toBe(
      'export const barks = ({"./grove/oak.ts": () => import("./grove/oak.ts").then((m) => m["bark\\u2028\\u2029"])})\n',
    )
  })

  test("a typeof guard reads function, and prose or strings that name the glob are left alone", () => {
    const dir = app(GROVE)
    const source = [
      "// import.meta.glob('./grove/*.ts') is expanded at build time",
      "const note = \"import.meta.glob('./x')\"",
      "export const loaders = typeof import.meta.glob === 'function' ? import.meta.glob('./grove/oak.ts') : {}",
      "",
    ].join("\n")
    expect(expandImportGlobs(source, join(dir, "src/load.ts"), dir)).toBe(
      [
        "// import.meta.glob('./grove/*.ts') is expanded at build time",
        "const note = \"import.meta.glob('./x')\"",
        'export const loaders = "function" === \'function\' ? ({"./grove/oak.ts": () => import("./grove/oak.ts")}) : {}',
        "",
      ].join("\n"),
    )
  })

  test("a page that shows the call in JSX text is left alone, and one that also calls it is refused", () => {
    const dir = app(GROVE)
    const file = join(dir, "src/page.tsx")
    const shown = [
      "export const Page = () => (",
      "  <p>",
      "    it's <code>import.meta.glob</code>, as in import.meta.glob('./grove/*.ts')",
      "  </p>",
      ")",
      "",
    ].join("\n")
    expect(expandImportGlobs(shown, file, dir)).toBe(shown)
    const both = `${shown}export const loaders = import.meta.glob('./grove/*.ts')\n`
    expect(() => expandImportGlobs(both, file, dir)).toThrow(
      `[nifra/web] ${file}: the Bun build cannot tell this module's import.meta.glob calls from text that names it`,
    )
    const called =
      "export const Page = () => <p>{Object.keys(import.meta.glob('./grove/{oak,birch}.ts')).length}</p>\n"
    expect(expandImportGlobs(called, file, dir)).toBe(
      'export const Page = () => <p>{Object.keys(({"./grove/birch.ts": () => import("./grove/birch.ts"), "./grove/oak.ts": () => import("./grove/oak.ts")})).length}</p>\n',
    )
  })

  test("a call inside a template's expression is expanded, and the template's text is not read", () => {
    const dir = app(GROVE)
    const source =
      "export const n = `import.meta.glob() ${Object.keys(import.meta.glob('./grove/oak.ts')).length} {}`\n"
    expect(expandImportGlobs(source, join(dir, "src/load.ts"), dir)).toBe(
      'export const n = `import.meta.glob() ${Object.keys(({"./grove/oak.ts": () => import("./grove/oak.ts")})).length} {}`\n',
    )
  })

  test("a call this cannot read is refused, naming the file and line", () => {
    const dir = app(GROVE)
    const file = join(dir, "src/load.ts")
    const refusal = (source: string): string => {
      try {
        expandImportGlobs(source, file, dir)
        return "expanded"
      } catch (error) {
        return error instanceof Error ? (error.message.split(". ")[0] ?? "") : String(error)
      }
    }
    expect(refusal("const at = 'x'\nimport.meta.glob(`./${at}/*.ts`)")).toBe(
      `[nifra/web] ${file}:2: import.meta.glob takes arguments that are not literals`,
    )
    expect(refusal("import.meta.glob('@/grove/*.ts')")).toBe(
      `[nifra/web] ${file}:1: import.meta.glob takes a pattern that does not start with ./, ../ or /`,
    )
    expect(refusal("import.meta.glob('./grove/*.ts', { query: '?raw' })")).toBe(
      `[nifra/web] ${file}:1: import.meta.glob takes the query option, which the Bun build does not support`,
    )
    expect(refusal("const glob = import.meta.glob")).toBe(
      `[nifra/web] ${file}:1: import.meta.glob is read as a value, not called`,
    )
  })

  test("a bundle that still calls the glob is refused, naming each chunk", () => {
    expect(() => assertNoImportGlob([["a.js", "const x = 1"]])).not.toThrow()
    expect(() =>
      assertNoImportGlob([
        ["a.js", "typeof import.meta.glob"],
        ["b.js", "import.meta.glob('./x/*.ts')"],
      ]),
    ).toThrow("[nifra/web] b.js still calls import.meta.glob")
  })
})

describe("buildClient", () => {
  const grove = Object.fromEntries(
    Object.entries(GROVE).map(([path, text]) => [path.replace(/^src\//, "frontend/"), text]),
  )
  const client = {
    ...grove,
    "routes/index.tsx": [
      'import { loaders } from "../frontend/load.ts"',
      "export const count = Object.keys(loaders).length",
      "export default function Index() { return null }",
      "",
    ].join("\n"),
    "frontend/load.ts": "export const loaders = import.meta.glob('./grove/*.ts')\n",
    "frontend/client-stub.ts": "export function mountRouter() {}\n",
  }

  test("ships a chunk for every file a glob loads", async () => {
    const dir = app(client)
    const outDir = join(dir, "dist")
    await buildClient({
      routesDir: join(dir, "routes"),
      outDir,
      clientModule: join(dir, "frontend/client-stub.ts"),
      minify: false,
    })
    const code = readdirSync(outDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(outDir, name), "utf8"))
    expect(code.some((text) => text.includes("ridged"))).toBe(true)
    expect(code.some((text) => text.includes("papery"))).toBe(true)
    expect(code.some((text) => /import\.meta\.glob/.test(text))).toBe(false)
  }, 60_000)

  test("a module an app plugin loads keeps its call, and the build refuses it", async () => {
    const dir = app(client)
    const claim: BunPlugin = {
      name: "claims-load",
      setup(build) {
        build.onLoad({ filter: /load\.ts$/ }, async (args) => ({
          contents: await Bun.file(args.path).text(),
          loader: "ts",
        }))
      },
    }
    await expect(
      buildClient({
        routesDir: join(dir, "routes"),
        outDir: join(dir, "dist"),
        clientModule: join(dir, "frontend/client-stub.ts"),
        minify: false,
        plugins: [claim],
      }),
    ).rejects.toThrow("still calls import.meta.glob")
  }, 60_000)
})
