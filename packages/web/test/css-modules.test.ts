import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cssModulesBunPlugin, transformCssModule } from "../src/plugins/css-modules.ts"

type LoadCb = (args: {
  path: string
}) => Promise<{ contents: string; loader: string }> | { contents: string; loader: string }
type ResolveCb = (args: { path: string }) => { path: string; namespace: string }

/**
 * Drive `cssModulesBunPlugin(generate).setup` with a fake Bun build, capturing the handlers it
 * registers: the `.module.css` loader (file namespace), the virtual `?nifra-css-module` CSS loader
 * (namespaced), and its resolver. Mirrors the web-vue plugin test harness.
 */
function setupCssModulesPlugin(generate: "dom" | "ssr") {
  let cssModuleLoad: LoadCb | undefined
  let cssLoad: LoadCb | undefined
  let cssResolve: ResolveCb | undefined
  cssModulesBunPlugin(generate).setup({
    onLoad: (opts: { namespace?: string }, cb: LoadCb) => {
      if (opts.namespace === undefined) cssModuleLoad = cb
      else cssLoad = cb
    },
    onResolve: (_opts: unknown, cb: ResolveCb) => {
      cssResolve = cb
    },
  } as never)
  return { cssModuleLoad, cssLoad, cssResolve }
}

const SCOPED = /^[\w-]+_[0-9a-f]{8}$/

describe("transformCssModule — class scoping", () => {
  test("simple class is scoped + exported; the scoped name follows `<name>_<hash8>`", () => {
    const { exports, css } = transformCssModule(".title { color: red }", "/routes/x.module.css")
    expect(Object.keys(exports)).toEqual(["title"])
    expect(exports.title).toMatch(SCOPED)
    expect(css).toBe(`.${exports.title} { color: red }`)
  })

  test("descendant + compound selectors scope every class", () => {
    const { exports, css } = transformCssModule(
      ".card .title.active { color: red }",
      "/routes/x.module.css",
    )
    expect(new Set(Object.keys(exports))).toEqual(new Set(["card", "title", "active"]))
    expect(css).toBe(`.${exports.card} .${exports.title}.${exports.active} { color: red }`)
  })

  test("the SAME class used twice maps to ONE stable scoped name", () => {
    const { exports, css } = transformCssModule(
      ".a { color: red } .a:hover { color: blue }",
      "/r/x.module.css",
    )
    expect(Object.keys(exports)).toEqual(["a"])
    expect(css).toBe(`.${exports.a} { color: red } .${exports.a}:hover { color: blue }`)
  })

  test("ids, elements, and attribute selectors are left untouched (only classes scope)", () => {
    const { exports, css } = transformCssModule(
      `#main a[href=".foo"] .btn { color: red }`,
      "/r/x.module.css",
    )
    expect(Object.keys(exports)).toEqual(["btn"]) // `.foo` inside the attribute string is NOT scoped
    expect(css).toContain(`#main a[href=".foo"] .${exports.btn}`)
  })

  test("kebab-case class names are preserved as keys (asIs convention)", () => {
    const { exports } = transformCssModule(".my-card { color: red }", "/r/x.module.css")
    expect(exports["my-card"]).toMatch(SCOPED)
  })
})

describe("transformCssModule — :global / :local", () => {
  test(":global(...) leaves its classes unscoped + out of the export map; unwraps the wrapper", () => {
    const { exports, css } = transformCssModule(
      ":global(.no-touch) .card { color: red }",
      "/r/x.module.css",
    )
    expect(Object.keys(exports)).toEqual(["card"])
    expect(css).toBe(`.no-touch .${exports.card} { color: red }`)
  })

  test("nested :global(:not(.x)) keeps .x global while a sibling :not(.y) scopes .y", () => {
    const { exports, css } = transformCssModule(
      ":global(:not(.x)) :not(.y) { color: red }",
      "/r/x.module.css",
    )
    expect(Object.keys(exports)).toEqual(["y"])
    expect(css).toBe(`:not(.x) :not(.${exports.y}) { color: red }`)
  })

  test(":local(...) scopes inside an otherwise-global context + unwraps", () => {
    const { exports, css } = transformCssModule(":local(.scoped) { color: red }", "/r/x.module.css")
    expect(exports.scoped).toMatch(SCOPED)
    expect(css).toBe(`.${exports.scoped} { color: red }`)
  })

  test("the unsupported bare :global/:local SWITCH form throws loudly (not silent mis-scoping)", () => {
    expect(() => transformCssModule(":global .foo { color: red }", "/r/x.module.css")).toThrow(
      /bare ":global" switch is unsupported.*:global\(\.\.\.\).*\/r\/x\.module\.css/,
    )
    expect(() => transformCssModule(":local .foo { color: red }", "/r/x.module.css")).toThrow(
      /bare ":local" switch is unsupported/,
    )
  })

  test("a pseudo-class that merely starts with global/local is left alone (no false throw)", () => {
    // `:global-x` is not the switch form (followed by `-`), so it must pass through untouched.
    expect(() => transformCssModule(":global-x .a { color: red }", "/r/x.module.css")).not.toThrow()
    const { exports } = transformCssModule(":global-x .a { color: red }", "/r/x.module.css")
    expect(Object.keys(exports)).toEqual(["a"])
  })
})

describe("transformCssModule — at-rules, nesting, and non-selector contexts", () => {
  test("@media block: nested rule selectors are scoped, the prelude is left alone", () => {
    const { exports, css } = transformCssModule(
      "@media (min-width: 700px) { .grid { display: grid } }",
      "/r/x.module.css",
    )
    expect(Object.keys(exports)).toEqual(["grid"])
    expect(css).toBe(`@media (min-width: 700px) { .${exports.grid} { display: grid } }`)
  })

  test("@keyframes selectors (from/to/%) are NOT treated as classes", () => {
    const { exports, css } = transformCssModule(
      "@keyframes spin { from { opacity: 0 } to { opacity: 1 } }",
      "/r/x.module.css",
    )
    // The keyframe NAME is exported (see below); `from`/`to`/`50%` are not — they are selectors inside
    // the block, not exportable identifiers.
    expect(Object.keys(exports)).toEqual(["spin"])
    expect(css).toContain("from { opacity: 0 }") // the from/to block is untouched
  })

  test("the @keyframes NAME is exported, scoped, matching the stylesheet", () => {
    // Keyframe names are part of the CSS Modules export namespace: postcss-modules exports them, so Vite
    // does, so nifra's dev pipeline does. Omitting them made `styles.spin` a real value in dev and
    // `undefined` in production — a divergence with no error at either end. Pinned by the dev/prod parity
    // gate (packages/web/test/pipeline-parity.test.ts).
    const { exports, css } = transformCssModule(
      "@keyframes spin { from { opacity: 0 } }",
      "/r/x.module.css",
    )
    expect(exports.spin).toMatch(/^spin_[0-9a-f]{8}$/)
    expect(css).toContain(`@keyframes ${exports.spin}`)
  })

  test("a class and a keyframe sharing one name: the CLASS wins the export", () => {
    // Deterministic by construction (keyframes seed the map, classes overwrite), because a name that has
    // to agree across two pipelines cannot be order-dependent. `styles.x` in markup means a className.
    const { exports, css } = transformCssModule(
      ".spin { color: red } @keyframes spin { from { opacity: 0 } }",
      "/r/x.module.css",
    )
    expect(css).toContain(`.${exports.spin} { color: red }`)
    // The keyframe is still scoped in the stylesheet, just under its own distinct salted name.
    expect(css).toMatch(/@keyframes spin_[0-9a-f]{8}/)
    expect(css).not.toContain(`@keyframes ${exports.spin} `)
  })

  // The SCOPED keyframe name (anchored on `@keyframes` so it never matches a same-named class).
  const kf = (css: string, name = "spin"): string =>
    new RegExp(`@(?:-\\w+-)?keyframes (${name}_[0-9a-f]{8})`).exec(css)?.[1] ?? ""

  test("@keyframes name + its animation-name reference are scoped to the SAME name", () => {
    const { css } = transformCssModule(
      ".box { animation-name: spin } @keyframes spin { from { opacity: 0 } to { opacity: 1 } }",
      "/r/x.module.css",
    )
    const scoped = kf(css)
    expect(scoped).not.toBe("")
    expect(css).toContain(`@keyframes ${scoped}`)
    expect(css).toContain(`animation-name: ${scoped}`) // reference matches the scoped keyframe
    expect(css).not.toMatch(/animation-name:\s*spin\b/) // never the bare global name
  })

  test("animation shorthand: only the keyframe-name token is remapped (timing/keywords untouched)", () => {
    const { css } = transformCssModule(
      "@keyframes spin {} .box { animation: 2s ease-in-out spin infinite }",
      "/r/x.module.css",
    )
    expect(css).toContain(`animation: 2s ease-in-out ${kf(css)} infinite`)
  })

  test("forward reference: animation declared before its @keyframes still remaps", () => {
    const { css } = transformCssModule(
      ".box { animation-name: pulse } @keyframes pulse { from {} to {} }",
      "/r/x.module.css",
    )
    expect(css).toContain(`animation-name: ${kf(css, "pulse")}`)
  })

  test("cross-module: the same keyframe name in two files gets DISTINCT scoped names", () => {
    const a = transformCssModule("@keyframes spin { to {} }", "/r/a.module.css")
    const b = transformCssModule("@keyframes spin { to {} }", "/r/b.module.css")
    expect(kf(a.css)).not.toBe(kf(b.css)) // no cross-module clobber
  })

  test("a class and a @keyframes sharing a name get different scoped names", () => {
    const { exports, css } = transformCssModule(
      ".spin { color: red } @keyframes spin { to {} }",
      "/r/x.module.css",
    )
    expect(exports.spin).not.toBe(kf(css)) // distinct salts
  })

  test("vendor-prefixed @-webkit-keyframes is scoped too", () => {
    const { css } = transformCssModule(
      "@-webkit-keyframes spin { to {} } .b { animation-name: spin }",
      "/r/x.module.css",
    )
    expect(css).toMatch(/@-webkit-keyframes spin_[0-9a-f]{8}/)
  })

  test("native nesting: nested class rules scope, declarations are untouched", () => {
    const { exports, css } = transformCssModule(
      ".card { color: red; .title { font-weight: 700 } }",
      "/r/x.module.css",
    )
    expect(new Set(Object.keys(exports))).toEqual(new Set(["card", "title"]))
    expect(css).toBe(`.${exports.card} { color: red; .${exports.title} { font-weight: 700 } }`)
  })

  test("a class-like token inside a declaration value (content/url) is NOT scoped", () => {
    const { exports, css } = transformCssModule(
      `.icon { content: ".foo"; background: url(./a.svg) }`,
      "/r/x.module.css",
    )
    expect(Object.keys(exports)).toEqual(["icon"])
    expect(css).toContain(`content: ".foo"`) // the string value is preserved verbatim
  })

  test("comments are preserved and their contents are not scoped", () => {
    const { exports, css } = transformCssModule(
      "/* .ghost */ .real { color: red }",
      "/r/x.module.css",
    )
    expect(Object.keys(exports)).toEqual(["real"])
    expect(css).toContain("/* .ghost */")
  })
})

describe("transformCssModule — determinism + cross-file isolation", () => {
  test("identical input → byte-identical output across runs (no time/random)", () => {
    const a = transformCssModule(".a { color: red }", "/r/x.module.css")
    const b = transformCssModule(".a { color: red }", "/r/x.module.css")
    expect(a).toEqual(b)
  })

  test("the same class name in two different files gets two different scoped names", () => {
    const one = transformCssModule(".a { color: red }", "/r/one.module.css")
    const two = transformCssModule(".a { color: red }", "/r/two.module.css")
    expect(one.exports.a).not.toBe(two.exports.a)
  })
})

describe("transformCssModule — unsupported features fail loud", () => {
  test('"composes" throws with the file + a workaround (with and without a trailing semicolon)', () => {
    expect(() => transformCssModule(".a { composes: base; }", "/r/x.module.css")).toThrow(
      /"composes" is unsupported in \/r\/x\.module\.css/,
    )
    expect(() => transformCssModule(".a { composes: base }", "/r/x.module.css")).toThrow(
      /"composes" is unsupported/,
    )
  })

  test('"@value" throws with a CSS-custom-property suggestion', () => {
    expect(() =>
      transformCssModule("@value primary: #fff;\n.a { color: red }", "/r/x.module.css"),
    ).toThrow(/"@value" is unsupported.*custom properties/)
  })

  test("a property merely starting with 'composes' (e.g. composes-x) is NOT rejected", () => {
    expect(() => transformCssModule(".a { composes-x: 1 }", "/r/x.module.css")).not.toThrow()
  })
})

describe("transformCssModule — robustness on malformed/edge input", () => {
  test("unbalanced braces bail gracefully (emit remainder, no throw)", () => {
    expect(() => transformCssModule(".a { color: red", "/r/x.module.css")).not.toThrow()
    const { css } = transformCssModule(".a { color: red", "/r/x.module.css")
    expect(css).toContain("color: red")
  })

  test("an unterminated comment does not throw", () => {
    expect(() => transformCssModule(".a {} /* trailing", "/r/x.module.css")).not.toThrow()
  })

  test("a brace inside a string value is not mistaken for a block boundary", () => {
    const { exports, css } = transformCssModule(
      `.a { content: "{" } .b { color: red }`,
      "/r/x.module.css",
    )
    expect(new Set(Object.keys(exports))).toEqual(new Set(["a", "b"]))
    expect(css).toContain(`content: "{"`)
  })

  test("an escaped quote inside an attribute-selector string is handled", () => {
    const { exports } = transformCssModule(`[data-x="a\\"b"] .c { color: red }`, "/r/x.module.css")
    expect(Object.keys(exports)).toEqual(["c"])
  })

  test("a lone dot (not a class) is left as-is and does not throw", () => {
    expect(() => transformCssModule(". { color: red }", "/r/x.module.css")).not.toThrow()
  })
})

describe("cssModulesBunPlugin — wiring + SSR/dom parity", () => {
  const fixture = new URL("./fixtures/styles.module.css", import.meta.url).pathname

  test("dom: the import emits the class map AND a virtual ?nifra-css-module CSS import", async () => {
    const { cssModuleLoad, cssLoad, cssResolve } = setupCssModulesPlugin("dom")
    expect(cssModuleLoad).toBeDefined()
    const out = await (cssModuleLoad as LoadCb)({ path: `${fixture}?v=1` }) // ?query stripped before read
    expect(out.loader).toBe("js")
    expect(out.contents).toContain("export default")
    expect(out.contents).toContain(`${fixture}${"?nifra-css-module"}`)

    // The resolver routes the virtual specifier into the namespace; the namespaced loader returns CSS.
    const resolved = (cssResolve as ResolveCb)({ path: `${fixture}?nifra-css-module` })
    expect(resolved.namespace).toBe("nifra-css-module")
    const css = await (cssLoad as LoadCb)({ path: resolved.path })
    expect(css.loader).toBe("css")
    expect(css.contents).toMatch(/\.title_[0-9a-f]{8}/) // scoped selector in the emitted stylesheet
  })

  test("dom: the virtual CSS loader returns empty for a path it never compiled (safe fallback)", async () => {
    const { cssLoad } = setupCssModulesPlugin("dom")
    const css = await (cssLoad as LoadCb)({ path: "/never/seen.module.css?nifra-css-module" })
    expect(css.contents).toBe("")
    expect(css.loader).toBe("css")
  })

  test("ssr: emits the class map but NO CSS import (stylesheet ships from the client build)", async () => {
    const { cssModuleLoad } = setupCssModulesPlugin("ssr")
    const out = await (cssModuleLoad as LoadCb)({ path: fixture })
    expect(out.contents).toContain("export default")
    expect(out.contents).not.toContain("?nifra-css-module")
  })

  test("ssr and dom produce the IDENTICAL class map (so SSR markup matches the bundled CSS)", async () => {
    const dom = setupCssModulesPlugin("dom")
    const ssr = setupCssModulesPlugin("ssr")
    const domOut = await (dom.cssModuleLoad as LoadCb)({ path: fixture })
    const ssrOut = await (ssr.cssModuleLoad as LoadCb)({ path: fixture })
    const domMap = JSON.parse(
      (domOut.contents.match(/export default (\{.*\})/) as RegExpMatchArray)[1] as string,
    )
    const ssrMap = JSON.parse(
      (ssrOut.contents.match(/export default (\{.*\})/) as RegExpMatchArray)[1] as string,
    )
    expect(domMap).toEqual(ssrMap)
    expect(domMap.title).toMatch(SCOPED)
  })
})

describe("cssModulesBunPlugin — real Bun.build (production path)", () => {
  const outDirs: string[] = []
  afterAll(() => {
    for (const dir of outDirs) rmSync(dir, { recursive: true, force: true })
  })

  test("dom build: JS imports the scoped class map AND a scoped CSS asset is emitted", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "nifra-cssm-"))
    outDirs.push(workDir)
    // Build-input written to a temp dir (not committed source) so it isn't part of the TS program —
    // a `.module.css` import needs the shipped ambient declaration to typecheck, which app tsconfigs
    // opt into; the root monorepo program stays free of a global `*.module.css` module.
    const entry = join(workDir, "entry.ts")
    writeFileSync(join(workDir, "styles.module.css"), ".title { color: rebeccapurple }\n")
    writeFileSync(
      entry,
      `import styles from "./styles.module.css"\nexport const titleClass = styles.title\n`,
    )
    const outDir = join(workDir, "out")
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: outDir,
      target: "browser",
      plugins: [cssModulesBunPlugin("dom")], // must win over Bun's native .module.css handling
    })
    expect(result.success).toBe(true)

    const js = await (
      result.outputs.find((o) => o.path.endsWith(".js")) as { text(): Promise<string> }
    ).text()
    const scoped = (js.match(/title:\s*"([\w-]+_[0-9a-f]{8})"/) as RegExpMatchArray)[1] as string
    expect(scoped).toMatch(SCOPED)

    const cssOut = result.outputs.find((o) => o.path.endsWith(".css")) as {
      text(): Promise<string>
    }
    expect(cssOut).toBeDefined()
    const css = await cssOut.text()
    expect(css).toContain(`.${scoped}`) // the emitted stylesheet uses the same scoped name as the JS map
    expect(css).not.toContain(".title ") // the original, unscoped class name must not survive
  })
})
