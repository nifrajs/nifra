import { expect, test } from "bun:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { mdxBunPlugin } from "../src/mdx.ts"

const fixture = join(import.meta.dir, "fixtures", "mdx", "page.mdx")
type MdxLoad = (args: { path: string }) => Promise<{ contents: string; loader: string }>

async function captureMdxLoad(): Promise<MdxLoad> {
  let load: MdxLoad | undefined
  await mdxBunPlugin().setup({
    onLoad: (_options: unknown, callback: MdxLoad) => {
      load = callback
    },
  } as never)
  if (load === undefined) throw new Error("mdx plugin did not register an onLoad handler")
  return load
}

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
  // Vue 3 ships a JSX runtime, so the same plugin covers it - no Vue-specific MDX compiler needed.
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

test("the loader accepts file URLs and keeps Windows URL paths filesystem-safe", async () => {
  const load = await captureMdxLoad()
  const fromUrl = await load({ path: `${pathToFileURL(fixture).href}?v=1` })
  expect(fromUrl.loader).toBe("jsx")
  expect(fromUrl.contents).toContain("MDXContent")

  // Malformed file URLs are handed to Bun's filesystem boundary instead of being silently rewritten.
  await expect(load({ path: "file://%" })).rejects.toThrow()

  // Exercise the Windows URL-path form on the POSIX coverage runner without leaving the process in a
  // spoofed platform state while the asynchronous filesystem read is pending.
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { value: "win32" })
  const pending = load({ path: "/C:/nifra-missing-mdx/page.mdx" })
  Object.defineProperty(process, "platform", platform)
  await expect(pending).rejects.toThrow()
})
