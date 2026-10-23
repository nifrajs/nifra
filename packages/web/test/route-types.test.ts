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
      file.slice(root.length + 1).replaceAll("\\", "/"),
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

  test("a part-literal segment carries the params inside it", () => {
    write("routes/post-[id].tsx", "export default () => null\n")
    write("routes/[lang]-feed/[year]-[month].xml.tsx", "export default () => null\n")
    writeRouteTypes({ appRoot: root })
    expect(generated("routes/+types/post-[id].d.ts")).toContain(
      "export type Params = { readonly id: string }",
    )
    expect(generated("routes/[lang]-feed/+types/[year]-[month].xml.d.ts")).toContain(
      "export type Params = { readonly lang: string; readonly year: string; readonly month: string }",
    )
  })

  test("a quote or line break in a route file name still generates valid TypeScript", () => {
    // A double quote is not a Windows filename character; apostrophes and U+2028 are portable.
    const name = `it's x`
    write(`routes/${name}.tsx`, "export default () => null\n")
    write(`routes/${name}.backend.ts`, "export const loader = () => ({})\n")
    const [source] = [...routeTypeFiles({ appRoot: root }).values()]
    if (source === undefined) throw new Error("no route type file generated")
    const diagnostics = ts.transpileModule(source, {
      fileName: "route.ts",
      reportDiagnostics: true,
    })
    expect(diagnostics.diagnostics ?? []).toEqual([])
    expect(source).toContain(`it's\\u2028x.backend`)
    expect(source.split("\n")[0]).toContain("\\u2028")
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

  test("Route.Loader and Route.Action check what they return against the output schemas", () => {
    write(
      "routes/feed/[id].backend.ts",
      [
        'import { t } from "@nifrajs/schema"',
        'import { defer, redirect, revalidate } from "@nifrajs/web"',
        'import type { Route } from "./+types/[id]"',
        "export const loaderOutput = t.object({ title: t.string(), feed: t.deferred(t.array(t.number())) })",
        "export const actionOutput = t.object({ ok: t.boolean() })",
        "export const loader: Route.Loader = async ({ params }) => {",
        '  if (params.id === "old") return redirect("/feed/new")',
        "  return { title: params.id, feed: defer(Promise.resolve([1, 2])) }",
        "}",
        "export const action: Route.Action = async ({ params }) => {",
        '  if (params.id === "x") return',
        '  return revalidate(["/feed"], { ok: true })',
        "}",
        "export const wrongField: Route.Loader = () => ({",
        "  // @ts-expect-error title is a string",
        "  title: 1,",
        "  feed: defer(Promise.resolve([1])),",
        "})",
        "// A field the schema does not declare type-checks: the output guard drops it before it ships.",
        "export const droppedField: Route.Loader = () => ({",
        '  title: "t",',
        "  feed: defer(Promise.resolve([1])),",
        '  internalNote: "x",',
        "})",
        "export const wrongDeferred: Route.Loader = () => ({",
        '  title: "t",',
        "  // @ts-expect-error the deferred value resolves to numbers",
        '  feed: defer(Promise.resolve(["a"])),',
        "})",
        "export const wrongRevalidate: Route.Action = () =>",
        "  // @ts-expect-error ok is a boolean",
        '  revalidate(["/"], { ok: "yes" })',
        "",
      ].join("\n"),
    )
    write("routes/feed/[id].tsx", "export default () => null\n")
    write(
      "routes/plain.backend.ts",
      [
        'import { redirect } from "@nifrajs/web"',
        'import type { Route } from "./+types/plain"',
        'export const loader: Route.Loader = () => redirect("/")',
        "// @ts-expect-error no loaderOutput: data is refused",
        "export const data: Route.Loader = () => ({ secret: 1 })",
        "",
      ].join("\n"),
    )
    write("routes/plain.tsx", "export default () => null\n")
    writeRouteTypes({ appRoot: root })
    expect(generated("routes/feed/+types/[id].d.ts")).toContain(
      "export type Loader = (args: LoaderArgs) => RouteLoaderReturn<Backend>",
    )
    expect(typeErrors(["routes/feed/[id].backend.ts", "routes/plain.backend.ts"])).toEqual([])
  }, 60_000)

  test("Route.BoundaryLoaders refuses a key the page does not declare, and a missing hole", () => {
    const page = (asConst: string) =>
      [
        `const cart = { name: "cart", mode: "dynamic", render: () => null }${asConst}`,
        `const own = { name: "own", mode: "dynamic", load: () => 1, render: () => null }${asConst}`,
        `const info = { name: "info", mode: "static", render: () => null }${asConst}`,
        "export const boundaries = [cart, own, info]",
        "export default () => null",
        "",
      ].join("\n")
    const backend = (name: string, extra: string, loaders: string) =>
      [
        `import type { Route } from "./+types/${name}"`,
        extra,
        `export const boundaryLoaders = ${loaders} satisfies Route.BoundaryLoaders`,
        "",
      ].join("\n")
    const cart = "cart: { load: (ctx) => ({ path: new URL(ctx.request.url).pathname }) }"
    const shell = "export const shellLoader = async () => ({})"
    write("routes/held.tsx", page(" as const"))
    write(
      "routes/held.backend.ts",
      backend("held", shell, `{ ${cart}, info: { load: (ctx) => ctx.phase } }`),
    )
    write("routes/misspelt.tsx", page(" as const"))
    write(
      "routes/misspelt.backend.ts",
      backend("misspelt", shell, `{ ${cart}, crat: { load: () => 1 } }`),
    )
    write("routes/missing.tsx", page(" as const"))
    write("routes/missing.backend.ts", backend("missing", shell, "{}"))
    write("routes/whole.tsx", page(" as const"))
    write("routes/whole.backend.ts", backend("whole", "", "{}"))
    write("routes/loose.tsx", page(""))
    write("routes/loose.backend.ts", backend("loose", shell, "{ crat: { load: () => 1 } }"))
    write("routes/shim.svelte", "<p>shim</p>\n")
    write("routes/shim.backend.ts", backend("shim", shell, "{ crat: { load: () => 1 } }"))
    writeRouteTypes({ appRoot: root })
    expect(generated("routes/+types/held.d.ts")).toContain(
      "export type BoundaryLoaders = BoundaryLoadersOf<Frontend, Backend>",
    )
    expect(generated("routes/+types/shim.d.ts")).toContain(
      "export type BoundaryLoaders = BoundaryLoadersOf<unknown, Backend>",
    )
    const errors = typeErrors(
      ["held", "misspelt", "missing", "whole", "loose", "shim"].map(
        (name) => `routes/${name}.backend.ts`,
      ),
    )
    expect(errors).toHaveLength(2)
    const [missing, misspelt] = errors.sort()
    expect(missing).toStartWith("routes/missing.backend.ts:3 ")
    expect(missing).toContain("Property 'cart' is missing")
    expect(misspelt).toStartWith("routes/misspelt.backend.ts:3 ")
    expect(misspelt).toContain("'crat' does not exist")
  }, 60_000)

  test("Route.BoundaryLoaders types a shared entry with the shell's context and needs revalidate", () => {
    write(
      "routes/stock.tsx",
      [
        'const price = { name: "price", mode: "shared", render: () => null } as const',
        'const cart = { name: "cart", mode: "dynamic", render: () => null } as const',
        "export const boundaries = [price, cart]",
        "export default () => null",
        "",
      ].join("\n"),
    )
    const cart = "cart: { load: (ctx) => ({ path: new URL(ctx.request.url).pathname }) }"
    const backend = (loaders: string) =>
      [
        'import type { Route } from "./+types/stock"',
        "export const shellLoader = async () => ({})",
        `export const boundaryLoaders = ${loaders} satisfies Route.BoundaryLoaders`,
        "",
      ].join("\n")
    const cases: Readonly<Record<string, string>> = {
      priced: `{ ${cart}, price: { load: (ctx) => ctx.params.id, revalidate: 30, revalidateTags: ["price"] } }`,
      unpriced: `{ ${cart}, price: { load: () => 1 } }`,
      nosy: `{ ${cart}, price: { load: (ctx) => ctx.request.url, revalidate: 30 } }`,
      timed: `{ cart: { load: () => 1, revalidate: 30 }, price: { load: () => 1, revalidate: 30 } }`,
      unfilled: `{ ${cart} }`,
    }
    const page = readFileSync(join(root, "routes/stock.tsx"), "utf8")
    for (const [name, loaders] of Object.entries(cases)) {
      write(`routes/${name}.tsx`, page)
      write(`routes/${name}.backend.ts`, backend(loaders).replace("+types/stock", `+types/${name}`))
    }
    writeRouteTypes({ appRoot: root })
    const errors = typeErrors(Object.keys(cases).map((name) => `routes/${name}.backend.ts`)).sort()
    expect(errors).toHaveLength(4)
    const [nosy, timed, unfilled, unpriced] = errors
    expect(nosy).toStartWith("routes/nosy.backend.ts:3 ")
    expect(nosy).toContain("Property 'request' does not exist on type 'SharedHoleCtx'")
    expect(timed).toStartWith("routes/timed.backend.ts:3 ")
    expect(timed).toContain("'revalidate' does not exist")
    expect(unfilled).toStartWith("routes/unfilled.backend.ts:3 ")
    expect(unfilled).toContain("Property 'price' is missing")
    expect(unpriced).toStartWith("routes/unpriced.backend.ts:3 ")
    expect(unpriced).toContain("Property 'revalidate' is missing")
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
