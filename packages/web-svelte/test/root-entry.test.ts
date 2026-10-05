import { expect, test } from "bun:test"
import { join } from "node:path"

// Every server and edge bundle links the adapter root. An edge build resolves `node:*` to Bun's
// browser polyfills, so a build-time or `node:` import here fails linking even when it is tree-shaken.
test("the root entry bundles for an edge target with no build-time or node: import", async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/index.ts")],
    target: "browser",
    conditions: ["workerd", "edge-light", "svelte", "browser"],
    packages: "external",
  })
  const code = await result.outputs[0]?.text()
  for (const buildTime of ["@nifrajs/web/plugins/kit", "svelte/compiler"])
    expect(code).not.toContain(buildTime)
  expect(code).not.toMatch(/["']node:/)
})
