import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import ts from "typescript"
import { routeTypeFiles, staleRouteTypes, writeRouteTypes } from "../src/route-types.ts"

// `nifra types` writes `.nifra/types/<routes>/<dir>/+types/<name>.d.ts` per route file. Temp apps live
// inside the workspace so `@nifrajs/*` resolves; the type checks read workspace source through the
// `bun` export condition, so they never depend on a stale `dist`.
const TMP = `${import.meta.dir}/.tmp-route-types-`
let root: string

const write = (path: string, text: string): void => {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const generated = (path: string): string => readFileSync(join(root, ".nifra/types", path), "utf8")

/** Type errors in `files`, as `file:line message`, with `.nifra/types` merged in through `rootDirs`. */
function typeErrors(files: readonly string[]): string[] {
  const program = ts.createProgram(
    files.map((file) => join(root, file)),
    {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      customConditions: ["bun"],
      allowImportingTsExtensions: true,
      jsx: ts.JsxEmit.Preserve,
      types: ["bun"],
      lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
      rootDirs: [root, join(root, ".nifra/types")],
    },
  )
  // Only the app's own files: workspace source is checked by the repo's typecheck, not here.
  const own = (diagnostic: ts.Diagnostic): boolean =>
    diagnostic.file === undefined || diagnostic.file.fileName.startsWith(root)
  return ts
    .getPreEmitDiagnostics(program)
    .filter(own)
    .map((diagnostic) => {
      const where =
        diagnostic.file === undefined || diagnostic.start === undefined
          ? ""
          : `${diagnostic.file.fileName.slice(root.length + 1)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1} `
      return where + ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
    })
}

beforeEach(() => {
  root = mkdtempSync(TMP)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("generated route types", () => {
  test("one module per route file, params from the path", () => {
    write("routes/index.tsx", "export default () => null\n")
    write("routes/_layout.tsx", "export default () => null\n")
    write("routes/[[lang]]/docs/[page].tsx", "export default () => null\n")
    write("routes/raw/files/[...path].tsx", "export default () => null\n")
    write("routes/(shop)/items/[id].svelte", "<p>item</p>\n")
    write("routes/_404.tsx", "export default () => null\n")
    const files = [...routeTypeFiles({ appRoot: root }).keys()].map((file) =>
      file.slice(root.length + 1),
    )
    expect(files.sort()).toEqual([
      ".nifra/types/routes/(shop)/items/+types/[id].d.ts",
      ".nifra/types/routes/+types/_404.d.ts",
      ".nifra/types/routes/+types/_layout.d.ts",
      ".nifra/types/routes/+types/index.d.ts",
      ".nifra/types/routes/[[lang]]/docs/+types/[page].d.ts",
      ".nifra/types/routes/raw/files/+types/[...path].d.ts",
    ])
    writeRouteTypes({ appRoot: root })
    expect(generated("routes/[[lang]]/docs/+types/[page].d.ts")).toContain(
      "export type Params = { readonly lang?: string; readonly page: string }",
    )
    expect(generated("routes/raw/files/+types/[...path].d.ts")).toContain(
      "export type Params = { readonly path: string }",
    )
    expect(generated("routes/(shop)/items/+types/[id].d.ts")).toContain(
      "export type Params = { readonly id: string }",
    )
    expect(generated("routes/+types/index.d.ts")).toContain(
      "export type Params = Record<string, never>",
    )
    expect(generated("routes/+types/_layout.d.ts")).toContain(
      "export type ComponentProps<Children = unknown> = {",
    )
  })

  test("data is the output schema's type, and api is the registered backend's", () => {
    write(
      "backend/app.ts",
      [
        'import { server } from "@nifrajs/core/server"',
        'export const backend = server().get("/hello", () => ({ message: "hi" }))',
        "",
      ].join("\n"),
    )
    write(
      "routes/blog/[slug].backend.ts",
      [
        'import { t } from "@nifrajs/schema"',
        'import type { Route } from "./+types/[slug]"',
        "export const loaderOutput = t.object({ title: t.string() })",
        "export async function loader({ api, params }: Route.LoaderArgs) {",
        "  const res = await api.hello.get()",
        "  const message: string = res.ok ? res.data.message : params.slug",
        "  // @ts-expect-error the registered backend serves no such route",
        "  api.missing.get()",
        "  // @ts-expect-error params carries only the path's own",
        "  params.other",
        '  return { title: message, internalNote: "dropped" }',
        "}",
        "",
      ].join("\n"),
    )
    write(
      "routes/blog/[slug].tsx",
      [
        'import type { Route } from "./+types/[slug]"',
        "export default function Post({ data, params }: Route.ComponentProps) {",
        "  const title: string = data.title",
        "  const slug: string = params.slug",
        "  // @ts-expect-error the schema does not declare it, so the component never receives it",
        "  data.internalNote",
        "  return [title, slug]",
        "}",
        "",
      ].join("\n"),
    )
    writeRouteTypes({ appRoot: root })
    expect(generated("register.d.ts")).toContain("readonly backend: typeof backend")
    expect(typeErrors(["routes/blog/[slug].tsx", "routes/blog/[slug].backend.ts"])).toEqual([])
  }, 60_000)

  test("a route with no backend half sends no data", () => {
    write(
      "routes/about.tsx",
      [
        'import type { Route } from "./+types/about"',
        "export default function About({ data }: Route.ComponentProps) {",
        "  const none: null = data",
        "  return none",
        "}",
        "",
      ].join("\n"),
    )
    writeRouteTypes({ appRoot: root })
    expect(typeErrors(["routes/about.tsx"])).toEqual([])
  }, 60_000)
})

describe("writeRouteTypes", () => {
  test("writes what changed, removes what no route generates, and reports staleness", () => {
    write("routes/a.tsx", "export default () => null\n")
    write("routes/b.tsx", "export default () => null\n")
    expect(staleRouteTypes({ appRoot: root })).toHaveLength(2)
    expect(writeRouteTypes({ appRoot: root }).written).toHaveLength(2)
    expect(staleRouteTypes({ appRoot: root })).toEqual([])
    expect(writeRouteTypes({ appRoot: root })).toEqual({ written: [], removed: [] })

    rmSync(join(root, "routes/b.tsx"))
    const b = join(root, ".nifra/types/routes/+types/b.d.ts")
    expect(staleRouteTypes({ appRoot: root })).toEqual([b])
    expect(writeRouteTypes({ appRoot: root })).toEqual({ written: [], removed: [b] })
    expect(existsSync(b)).toBe(false)
  })
})
