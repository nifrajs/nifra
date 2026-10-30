import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { routeTypeFiles, staleRouteTypes, writeRouteTypes } from "../src/route-types.ts"
import { typeApp } from "./_type-app.ts"

// `nifra types` writes `.nifra/types/<routes>/<dir>/+types/<name>.d.ts` per route file.
const app = typeApp(`${import.meta.dir}/.tmp-route-types-`)
const { write, generated, typeErrors } = app

describe("generated route types", () => {
  test("one module per route file, params from the path", () => {
    write("routes/index.tsx", "export default () => null\n")
    write("routes/_layout.tsx", "export default () => null\n")
    write("routes/[[lang]]/docs/[page].tsx", "export default () => null\n")
    write("routes/raw/files/[...path].tsx", "export default () => null\n")
    write("routes/(shop)/items/[id].svelte", "<p>item</p>\n")
    write("routes/_404.tsx", "export default () => null\n")
    const files = [...routeTypeFiles({ appRoot: app.root }).keys()].map((file) =>
      file.slice(app.root.length + 1).replaceAll("\\", "/"),
    )
    expect(files.sort()).toEqual([
      ".nifra/types/routes.d.ts",
      ".nifra/types/routes/(shop)/items/+types/[id].d.ts",
      ".nifra/types/routes/+types/_404.d.ts",
      ".nifra/types/routes/+types/_layout.d.ts",
      ".nifra/types/routes/+types/index.d.ts",
      ".nifra/types/routes/[[lang]]/docs/+types/[page].d.ts",
      ".nifra/types/routes/raw/files/+types/[...path].d.ts",
    ])
    writeRouteTypes({ appRoot: app.root })
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

  test("a layout or special page carries the params of the directory it wraps", () => {
    write("routes/[[lang]]/blog/[slug]/index.tsx", "export default () => null\n")
    write("routes/[[lang]]/blog/[slug]/_layout.tsx", "export default () => null\n")
    write("routes/[[lang]]/blog/[slug]/_404.tsx", "export default () => null\n")
    write("routes/_layout.tsx", "export default () => null\n")
    writeRouteTypes({ appRoot: app.root })
    const params = "export type Params = { readonly lang?: string; readonly slug: string }"
    expect(generated("routes/[[lang]]/blog/[slug]/+types/_layout.d.ts")).toContain(params)
    expect(generated("routes/[[lang]]/blog/[slug]/+types/_404.d.ts")).toContain(params)
    expect(generated("routes/+types/_layout.d.ts")).toContain(
      "export type Params = Record<string, never>",
    )
  })

  test("a part-literal segment carries the params inside it", () => {
    write("routes/post-[id].tsx", "export default () => null\n")
    write("routes/[lang]-feed/[year]-[month].xml.tsx", "export default () => null\n")
    writeRouteTypes({ appRoot: app.root })
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
    const sources = [...routeTypeFiles({ appRoot: app.root }).values()]
    const source = sources.find((text) => text.includes("export namespace Route"))
    const table = sources.find((text) => text.includes("interface RouteTable"))
    if (source === undefined || table === undefined) throw new Error("no route type file generated")
    for (const text of [source, table]) {
      const diagnostics = ts.transpileModule(text, {
        fileName: "route.ts",
        reportDiagnostics: true,
      })
      expect(diagnostics.diagnostics ?? []).toEqual([])
    }
    expect(source).toContain(`it's\\u2028x.backend`)
    expect(source.split("\n")[0]).toContain("\\u2028")
    expect(table).toContain(`"/it's\\u2028x"`)
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
    writeRouteTypes({ appRoot: app.root })
    expect(generated("register.d.ts")).toContain("readonly backend: typeof backend")
    expect(typeErrors(["routes/blog/[slug].tsx", "routes/blog/[slug].backend.ts"])).toEqual([])
  }, 60_000)

  test("Route.Loader and Route.Action check what they return against the output schemas", () => {
    write(
      "routes/feed/[id].backend.ts",
      [
        'import { t } from "@nifrajs/schema"',
        'import { defer, href, redirect, revalidate } from "@nifrajs/web"',
        'import type { Route } from "./+types/[id]"',
        "export const loaderOutput = t.object({ title: t.string(), feed: t.deferred(t.array(t.number())) })",
        "export const actionOutput = t.object({ ok: t.boolean() })",
        "export const loader: Route.Loader = async ({ params }) => {",
        '  if (params.id === "old") return redirect(href({ to: "/feed/:id", params: { id: "new" } }))',
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
        'import { href, redirect } from "@nifrajs/web"',
        'import type { Route } from "./+types/plain"',
        'export const loader: Route.Loader = () => redirect(href({ to: "/plain" }))',
        "// @ts-expect-error no loaderOutput: data is refused",
        "export const data: Route.Loader = () => ({ secret: 1 })",
        "",
      ].join("\n"),
    )
    write("routes/plain.tsx", "export default () => null\n")
    writeRouteTypes({ appRoot: app.root })
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
    writeRouteTypes({ appRoot: app.root })
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
    const page = readFileSync(join(app.root, "routes/stock.tsx"), "utf8")
    for (const [name, loaders] of Object.entries(cases)) {
      write(`routes/${name}.tsx`, page)
      write(`routes/${name}.backend.ts`, backend(loaders).replace("+types/stock", `+types/${name}`))
    }
    writeRouteTypes({ appRoot: app.root })
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
    writeRouteTypes({ appRoot: app.root })
    expect(typeErrors(["routes/about.tsx"])).toEqual([])
  }, 60_000)

  test("routes.d.ts holds one RouteTable entry per pattern, params from the compiled pattern", () => {
    for (const file of [
      "index.tsx",
      "[[lang]]/docs/[page].tsx",
      "raw/files/[...path].tsx",
      "(shop)/items/[id].svelte",
      "post-[id].tsx",
      "[lang]-feed/[year]-[month].xml.tsx",
    ])
      write(`routes/${file}`, "export default () => null\n")
    writeRouteTypes({ appRoot: app.root })
    const table = generated("routes.d.ts")
    const entries = [
      ...table.matchAll(/^ {4}("[^"]+"): \{ readonly params: (.+?); readonly search:/gm),
    ]
    expect(entries.map((entry) => [entry[1], entry[2]])).toEqual([
      ['"/"', "Record<string, never>"],
      [
        '"/:lang-feed/:year-:month.xml"',
        "{ readonly lang: string; readonly year: string; readonly month: string }",
      ],
      ['"/:lang/docs/:page"', "{ readonly lang: string; readonly page: string }"],
      ['"/docs/:page"', "{ readonly page: string }"],
      ['"/items/:id"', "{ readonly id: string }"],
      ['"/post-:id"', "{ readonly id: string }"],
      ['"/raw/files/*path"', "{ readonly path: string }"],
    ])
    // A script module's search comes from its `searchSchema`; a .svelte/.vue/.mdx one has no exports to read.
    expect(table).toContain(
      '"/post-:id": { readonly params: { readonly id: string }; readonly search: SearchOf<typeof import("../../routes/post-[id]")> }',
    )
    expect(table).toContain(
      '"/items/:id": { readonly params: { readonly id: string }; readonly search: Record<string, unknown> }',
    )
    // Every route module loads the table, so importing any one of them is enough.
    expect(generated("routes/+types/index.d.ts")).toContain(
      '/// <reference path="../../routes.d.ts" />',
    )
    expect(generated("routes/raw/files/+types/[...path].d.ts")).toContain(
      '/// <reference path="../../../../routes.d.ts" />',
    )
  })

  test("a page's Route.Params is what its RouteTable entries carry", () => {
    for (const file of [
      "index.tsx",
      "post-[id].tsx",
      "raw/[...path].tsx",
      "[[lang]]/docs/[page].tsx",
    ])
      write(`routes/${file}`, "export default () => null\n")
    writeRouteTypes({ appRoot: app.root })
    write(
      "check.ts",
      [
        'import type { RouteTable } from "@nifrajs/web"',
        'import type { Route as Index } from "./.nifra/types/routes/+types/index"',
        'import type { Route as Post } from "./.nifra/types/routes/+types/post-[id]"',
        'import type { Route as Raw } from "./.nifra/types/routes/raw/+types/[...path]"',
        'import type { Route as Docs } from "./.nifra/types/routes/[[lang]]/docs/+types/[page]"',
        "type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2",
        "  ? true",
        "  : false",
        'export const index: Same<RouteTable["/"]["params"], Index.Params> = true',
        'export const post: Same<RouteTable["/post-:id"]["params"], Post.Params> = true',
        'export const raw: Same<RouteTable["/raw/*path"]["params"], Raw.Params> = true',
        "// An optional segment is two table entries, and the page's params admit both.",
        'export const withLang: Docs.Params = {} as RouteTable["/:lang/docs/:page"]["params"]',
        'export const withoutLang: Docs.Params = {} as RouteTable["/docs/:page"]["params"]',
        "// @ts-expect-error the check is not vacuous: these two entries differ",
        'export const differs: Same<RouteTable["/docs/:page"]["params"], RouteTable["/:lang/docs/:page"]["params"]> = true',
        "",
      ].join("\n"),
    )
    expect(typeErrors(["check.ts"])).toEqual([])
  }, 60_000)

  test("importing a route's types loads the table, so href's search is typed", () => {
    write(
      "routes/reports.tsx",
      [
        'import { t } from "@nifrajs/schema"',
        "export const searchSchema = t.object({ page: t.number() })",
        "export default () => null",
        "",
      ].join("\n"),
    )
    write(
      "routes/reports/[id].tsx",
      [
        'import { t } from "@nifrajs/schema"',
        "export const searchSchema = t.object({ q: t.string() })",
        "export default () => null",
        "",
      ].join("\n"),
    )
    write("routes/plain.tsx", "export default () => null\n")
    writeRouteTypes({ appRoot: app.root })
    write(
      "check.ts",
      [
        'import { href } from "@nifrajs/web"',
        'import type { Route } from "./.nifra/types/routes/+types/plain"',
        "// Nothing but this import brings the table in.",
        "export type Loaded = Route.Params",
        'export const page = href({ to: "/reports", search: { page: 1 } })',
        "// @ts-expect-error page is a number",
        'export const wrong = href({ to: "/reports", search: { page: "x" } })',
        "// A dynamic route is typed too: its pattern is a key of its own.",
        'export const query = href({ to: "/reports/:id", params: { id: "7" }, search: { q: "a" } })',
        "// @ts-expect-error q is a string",
        'export const wrongQuery = href({ to: "/reports/:id", params: { id: "7" }, search: { q: 1 } })',
        "// @ts-expect-error a path that is no route is not a key of the table",
        'export const elsewhere = href({ to: "/elsewhere" })',
        "",
      ].join("\n"),
    )
    expect(typeErrors(["check.ts"])).toEqual([])
  }, 60_000)
})

describe("writeRouteTypes", () => {
  test("writes what changed, removes what no route generates, and reports staleness", () => {
    write("routes/a.tsx", "export default () => null\n")
    write("routes/b.tsx", "export default () => null\n")
    // Two route modules and the route table.
    expect(staleRouteTypes({ appRoot: app.root })).toHaveLength(3)
    expect(writeRouteTypes({ appRoot: app.root }).written).toHaveLength(3)
    expect(staleRouteTypes({ appRoot: app.root })).toEqual([])
    expect(writeRouteTypes({ appRoot: app.root })).toEqual({ written: [], removed: [] })

    // A removed route changes the table and removes its own module.
    rmSync(join(app.root, "routes/b.tsx"))
    const b = join(app.root, ".nifra/types/routes/+types/b.d.ts")
    const table = join(app.root, ".nifra/types/routes.d.ts")
    expect(staleRouteTypes({ appRoot: app.root })).toEqual([table, b].sort())
    expect(writeRouteTypes({ appRoot: app.root })).toEqual({ written: [table], removed: [b] })
    expect(existsSync(b)).toBe(false)
    expect(generated("routes.d.ts")).not.toContain('"/b"')
  })
})
