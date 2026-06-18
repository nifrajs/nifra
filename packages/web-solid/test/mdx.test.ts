import { expect, test } from "bun:test"
import { join } from "node:path"
import { solidMdxBunPlugin } from "../src/mdx.ts"
import { useMDXComponents } from "../src/mdx-runtime.ts"

test("mdx-runtime maps Markdown intrinsics to Solid components", () => {
  const c = useMDXComponents()
  // Every CommonMark/GFM output element is present as a callable Solid component (not a bare string).
  for (const tag of [
    "h1",
    "h2",
    "p",
    "a",
    "strong",
    "em",
    "code",
    "pre",
    "ul",
    "ol",
    "li",
    "img",
  ]) {
    expect(typeof c[tag]).toBe("function")
  }
  // Invoking one yields a Solid component result (createComponent(<Dynamic>, …)) — doesn't throw.
  expect(c.h1!({ children: "x" })).toBeDefined()
})

// Compiling `.mdx` → a Solid component happens in two stages (MDX → JSX → babel-preset-solid). This
// asserts on the compiled output (the render is proven by the cross-framework verification); a unit
// test stays in-package without the SSR-import dance.
test("solidMdxBunPlugin compiles .mdx → Solid SSR code via the intrinsics runtime", async () => {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures", "page.mdx")],
    plugins: [solidMdxBunPlugin("ssr")],
    target: "bun",
    external: ["solid-js", "solid-js/web", "@nifrajs/web-solid/mdx-runtime", "@mdx-js/mdx"],
  })
  expect(built.success).toBe(true)
  const code = await built.outputs[0]!.text()
  // Intrinsic elements resolve through the Solid runtime provider (rendered via <Dynamic>).
  expect(code).toContain("mdx-runtime")
  // babel-preset-solid ran: Solid `createComponent` calls (not raw JSX / React createElement). Every element
  // routes through the runtime's <Dynamic> provider, so they're component calls rather than `ssr()` templates.
  expect(code).toContain("createComponent")
  // The Markdown content is baked into the compiled output.
  expect(code).toContain("MDX on Solid")
  expect(code).toContain("bold")
})

test("dom mode compiles too (client build)", async () => {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures", "page.mdx")],
    plugins: [solidMdxBunPlugin("dom")],
    target: "browser",
    external: ["solid-js", "solid-js/web", "@nifrajs/web-solid/mdx-runtime", "@mdx-js/mdx"],
  })
  expect(built.success).toBe(true)
  expect(await built.outputs[0]!.text()).toContain("mdx-runtime")
})
