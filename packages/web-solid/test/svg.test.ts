import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { solidSvgComponentBunPlugin } from "../src/svg.ts"

type LoadCb = (args: { path: string }) => Promise<{ contents: string; loader: string }>

function setup(generate: "dom" | "ssr" = "dom") {
  let load: LoadCb | undefined
  solidSvgComponentBunPlugin(generate).setup({
    onLoad: (_o: unknown, cb: LoadCb) => {
      load = cb
    },
    onResolve: () => {},
  } as never)
  return load as LoadCb
}

const fixture = `${new URL("./fixtures/icon.svg", import.meta.url).pathname}?component`

describe("solidSvgComponentBunPlugin", () => {
  test("compiles a *.svg?component into a Solid component module (real babel)", async () => {
    const out = await setup("dom")({ path: fixture })
    expect(out.loader).toBe("js")
    // babel-preset-solid output: a template + a component export. It compiled without throwing.
    expect(out.contents.length).toBeGreaterThan(0)
    expect(out.contents).toContain("SvgComponent")
    // Solid keeps `class` (not className) - the source fed to babel used classProp: "class".
    expect(out.contents).toContain("class")
  })

  test("ssr generate produces a different (server) output", async () => {
    const dom = await setup("dom")({ path: fixture })
    const ssr = await setup("ssr")({ path: fixture })
    expect(ssr.contents.length).toBeGreaterThan(0)
    expect(ssr.contents).not.toBe(dom.contents) // solid dom vs ssr transforms differ
  })
})

describe("an exported stylesheet", () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-solid-svg-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("compiles: its braces reach babel as text, not as JSX expressions", async () => {
    const file = join(dir, "illustrator.svg")
    writeFileSync(
      file,
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.st0{fill:#FFF;}</style><path class="st0" d="M0 0"/></svg>',
    )
    const out = await setup("dom")({ path: `${file}?component` })
    // Solid's template is HTML: inside an <svg> a browser decodes the references back to braces.
    expect(out.contents).toContain(".st0&#123;fill:#FFF;&#125;")
  })
})
