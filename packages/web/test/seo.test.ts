import { expect, test } from "bun:test"
import { join } from "node:path"
import * as root from "../src/index.ts"
import * as seo from "../src/seo.ts"

test("the seo entry serves the root's helpers", () => {
  expect(Bun.resolveSync("@nifrajs/web/seo", import.meta.dir)).toBe(
    join(import.meta.dir, "..", "src", "seo.ts"),
  )
  expect(root.canonical).toBe(seo.canonical)
  expect(root.openGraph).toBe(seo.openGraph)
  expect(root.jsonLd).toBe(seo.jsonLd)
})

test("the seo entry bundles for the browser without importing anything", async () => {
  // A resolver plugin that returns its own path makes Bun bundle every module an entry re-exports,
  // so the entry has to be safe without tree-shaking: it may not import anything at runtime.
  const imports: string[] = []
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "src", "seo.ts")],
    target: "browser",
    plugins: [
      {
        name: "import-probe",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.importer !== "") imports.push(args.path)
            return undefined
          })
        },
      },
    ],
  })
  expect(result.success).toBe(true)
  expect(imports).toEqual([])
})
