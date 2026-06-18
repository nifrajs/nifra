import { expect, test } from "bun:test"
import { join } from "node:path"
import { mdxBunPlugin } from "../src/mdx.ts"

const fixture = join(import.meta.dir, "fixtures", "mdx", "page.mdx")

test("mdxBunPlugin compiles a .mdx file to a component module (default export + exports)", async () => {
  const built = await Bun.build({
    entrypoints: [fixture],
    plugins: [mdxBunPlugin({ jsxImportSource: "react" })],
    target: "bun",
    external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime"],
  })
  expect(built.success).toBe(true)
  const code = await built.outputs[0]?.text()
  expect(code).toContain("MDXContent") // the content component (default export)
  expect(code).toContain("react/jsx-runtime") // imports the configured JSX runtime
  expect(code).toContain('"h1"') // the heading element
  expect(code).toContain("MDX Page") // the `export const meta` survives
})

test("jsxImportSource is honored (preact)", async () => {
  const built = await Bun.build({
    entrypoints: [fixture],
    plugins: [mdxBunPlugin({ jsxImportSource: "preact" })],
    target: "bun",
    external: ["preact", "preact/jsx-runtime"],
  })
  expect(built.success).toBe(true)
  expect(await built.outputs[0]?.text()).toContain("preact/jsx-runtime")
})

test("jsxImportSource is honored (vue)", async () => {
  // Vue 3 ships a JSX runtime, so the same plugin covers it — no Vue-specific MDX compiler needed.
  const built = await Bun.build({
    entrypoints: [fixture],
    plugins: [mdxBunPlugin({ jsxImportSource: "vue" })],
    target: "bun",
    external: ["vue", "vue/jsx-runtime"],
  })
  expect(built.success).toBe(true)
  expect(await built.outputs[0]?.text()).toContain("vue/jsx-runtime")
})

test("a clear error when the @mdx-js/mdx compiler isn't installed", async () => {
  const plugin = mdxBunPlugin({ moduleName: "@mdx-js/__not-installed__" })
  // setup() loads the compiler eagerly, so a missing module rejects here (before any onLoad).
  await expect(plugin.setup({ onLoad() {} } as never)).rejects.toThrow(/@mdx-js\/mdx/)
})
