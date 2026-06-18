import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginBuilder } from "../src/plugins/kit.ts"
import { type SassCompiler, scssBunPlugin } from "../src/plugins/scss.ts"

type LoadCb = (args: {
  path: string
}) => Promise<{ contents: string; loader: string }> | { contents: string; loader: string }

const SCOPED = /^[\w-]+_[0-9a-f]{8}$/

/** A stub Sass compiler that records its calls and returns canned CSS — no real Dart Sass needed. */
function stubCompiler(css: string) {
  const calls: Array<{ source: string; syntax: string | undefined }> = []
  const compiler: SassCompiler = {
    compileString(source, options) {
      calls.push({ source, syntax: options?.syntax })
      return { css }
    },
  }
  return { compiler, calls }
}

/** Drive `scssBunPlugin(...).setup` with a fake build, capturing the file-namespace Sass loader. */
function setupScssPlugin(generate: "dom" | "ssr", compiler: SassCompiler) {
  let scssLoad: LoadCb | undefined
  scssBunPlugin(generate, { compiler }).setup({
    onLoad: (opts: { namespace?: string }, cb: LoadCb) => {
      if (opts.namespace === undefined) scssLoad = cb
    },
    onResolve: () => {},
  } as unknown as PluginBuilder)
  return scssLoad as LoadCb
}

describe("scssBunPlugin — plain *.scss (side-effect import)", () => {
  test("dom: compiles and emits the CSS as a virtual import, no default export", async () => {
    const { compiler, calls } = stubCompiler(".a { color: red }")
    const load = setupScssPlugin("dom", compiler)
    const fixture = new URL("./fixtures/plain.scss", import.meta.url).pathname
    const out = await load({ path: fixture })
    expect(out.loader).toBe("js")
    expect(out.contents).toContain("?nifra-scss")
    expect(out.contents).not.toContain("export default")
    expect(calls[0]?.syntax).toBe("scss")
  })

  test("ssr: resolves to an empty module (the stylesheet ships from the client build)", async () => {
    const { compiler } = stubCompiler(".a { color: red }")
    const load = setupScssPlugin("ssr", compiler)
    const fixture = new URL("./fixtures/plain.scss", import.meta.url).pathname
    const out = await load({ path: fixture })
    expect(out.contents).toBe("")
  })

  test(".sass extension is compiled with the indented syntax", async () => {
    const { compiler, calls } = stubCompiler(".a { color: red }")
    const load = setupScssPlugin("dom", compiler)
    await load({ path: new URL("./fixtures/indented.sass", import.meta.url).pathname })
    expect(calls[0]?.syntax).toBe("indented")
  })
})

describe("scssBunPlugin — *.module.scss (composes with CSS Modules)", () => {
  const moduleFixture = new URL("./fixtures/scoped.module.scss", import.meta.url).pathname

  test("dom: exports the scoped class map AND emits the scoped CSS", async () => {
    const { compiler } = stubCompiler(".title { color: red } .card .title { margin: 0 }")
    const load = setupScssPlugin("dom", compiler)
    const out = await load({ path: moduleFixture })
    expect(out.contents).toContain("export default")
    expect(out.contents).toContain("?nifra-scss")
    const map = JSON.parse(
      (out.contents.match(/export default (\{.*\})/) as RegExpMatchArray)[1] as string,
    )
    expect(map.title).toMatch(SCOPED)
    expect(map.card).toMatch(SCOPED)
  })

  test("ssr: exports the class map but emits NO CSS (matches the client scoped names)", async () => {
    const css = ".title { color: red }"
    const dom = setupScssPlugin("dom", stubCompiler(css).compiler)
    const ssr = setupScssPlugin("ssr", stubCompiler(css).compiler)
    const domOut = await dom({ path: moduleFixture })
    const ssrOut = await ssr({ path: moduleFixture })
    expect(ssrOut.contents).not.toContain("?nifra-scss")
    const domMap = JSON.parse(
      (domOut.contents.match(/export default (\{.*\})/) as RegExpMatchArray)[1] as string,
    )
    const ssrMap = JSON.parse(
      (ssrOut.contents.match(/export default (\{.*\})/) as RegExpMatchArray)[1] as string,
    )
    expect(domMap).toEqual(ssrMap)
  })
})

describe("scssBunPlugin — compile errors", () => {
  test("a Sass compile failure is attributed to the file + package (not a raw stack)", async () => {
    const throwing: SassCompiler = {
      compileString() {
        throw new Error("Expected expression. (line 3)")
      },
    }
    const load = setupScssPlugin("dom", throwing)
    const fixture = new URL("./fixtures/plain.scss", import.meta.url).pathname
    await expect(load({ path: fixture })).rejects.toThrow(
      /\[nifra\/web\] failed to compile .*plain\.scss: Expected expression/,
    )
  })
})

describe("scssBunPlugin — real Dart Sass via Bun.build (production path)", () => {
  const workDirs: string[] = []
  afterAll(() => {
    for (const dir of workDirs) rmSync(dir, { recursive: true, force: true })
  })

  test("plain .scss: nesting + variables compile and the CSS is bundled", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "nifra-scss-"))
    workDirs.push(workDir)
    writeFileSync(
      join(workDir, "styles.scss"),
      "$c: rebeccapurple;\n.card { color: $c; .title { font-weight: 700; } }\n",
    )
    const entry = join(workDir, "entry.ts")
    writeFileSync(entry, `import "./styles.scss"\nexport const x = 1\n`)
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: join(workDir, "out"),
      target: "browser",
      plugins: [scssBunPlugin("dom")], // no injected compiler → loads the real `sass` peer
    })
    expect(result.success).toBe(true)
    const cssOut = result.outputs.find((o) => o.path.endsWith(".css")) as {
      text(): Promise<string>
    }
    const css = await cssOut.text()
    expect(css).toContain("#639") // $c resolved + minified (rebeccapurple → #639)
    expect(css).toContain(".card .title") // nesting expanded
  })

  test(".module.scss: real Sass output is then class-scoped, JS imports the map", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "nifra-scss-"))
    workDirs.push(workDir)
    writeFileSync(join(workDir, "x.module.scss"), "$c: red;\n.title { color: $c; }\n")
    const entry = join(workDir, "entry.ts")
    writeFileSync(entry, `import s from "./x.module.scss"\nexport const t = s.title\n`)
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: join(workDir, "out"),
      target: "browser",
      plugins: [scssBunPlugin("dom")],
    })
    expect(result.success).toBe(true)
    const js = await (
      result.outputs.find((o) => o.path.endsWith(".js")) as { text(): Promise<string> }
    ).text()
    const scoped = (js.match(/title:\s*"([\w-]+_[0-9a-f]{8})"/) as RegExpMatchArray)[1] as string
    expect(scoped).toMatch(SCOPED)
    const css = await (
      result.outputs.find((o) => o.path.endsWith(".css")) as { text(): Promise<string> }
    ).text()
    expect(css).toContain(`.${scoped}`)
    expect(css).not.toContain(".title ")
  })

  test(".module.sass (indented syntax): real Sass compiles + the result is class-scoped", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "nifra-scss-"))
    workDirs.push(workDir)
    // Indented (`.sass`) syntax: no braces/semicolons — exercises the `syntax: "indented"` branch.
    writeFileSync(join(workDir, "x.module.sass"), "$c: red\n.title\n  color: $c\n")
    const entry = join(workDir, "entry.ts")
    writeFileSync(entry, `import s from "./x.module.sass"\nexport const t = s.title\n`)
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: join(workDir, "out"),
      target: "browser",
      plugins: [scssBunPlugin("dom")],
    })
    expect(result.success).toBe(true)
    const js = await (
      result.outputs.find((o) => o.path.endsWith(".js")) as { text(): Promise<string> }
    ).text()
    const scoped = (js.match(/title:\s*"([\w-]+_[0-9a-f]{8})"/) as RegExpMatchArray)[1] as string
    expect(scoped).toMatch(SCOPED)
    const css = await (
      result.outputs.find((o) => o.path.endsWith(".css")) as { text(): Promise<string> }
    ).text()
    expect(css).toContain(`.${scoped}`)
    expect(css).toContain("color: red")
    expect(css).not.toContain(".title ")
  })
})
