import { describe, expect, test } from "bun:test"
import { writeRouteTypes } from "../src/route-types.ts"
import { typeApp } from "./_type-app.ts"

const app = typeApp(`${import.meta.dir}/.tmp-href-types-`)
const { write, typeErrors } = app

const PAGE = "export default () => null\n"
const search = (fields: string): string =>
  `import { t } from "@nifrajs/schema"\nexport const searchSchema = t.object({ ${fields} })\n${PAGE}`

/** An app whose route table has every param shape: none, one, two with an optional first, a splat. */
function routes(): void {
  write("routes/index.tsx", PAGE)
  write(
    "routes/dashboard.tsx",
    `export const routeSlots = { inspector: ["/users/:id"] } as const\n${PAGE}`,
  )
  write("routes/users/[id].tsx", search("tab: t.string()"))
  write("routes/reports.tsx", search("page: t.number()"))
  write("routes/[[lang]]/docs/[page].tsx", PAGE)
  write("routes/files/[...path].tsx", PAGE)
  writeRouteTypes({ appRoot: app.root })
}

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`

describe("href() types", () => {
  test("route slots accept only registered names and allowed typed targets", () => {
    routes()
    write(
      "check.ts",
      lines(
        'import { href } from "@nifrajs/web"',
        'import type { Route } from "./.nifra/types/routes/+types/dashboard"',
        "export type Loaded = Route.Params",
        'const user = href({ to: "/users/:id", params: { id: "7" } })',
        'href({ to: "/dashboard", slots: { inspector: user } })',
        'href({ to: "/dashboard", slots: { inspector: null } })',
        "// @ts-expect-error the page does not register this slot",
        'href({ to: "/reports", slots: { inspector: user } })',
        "// @ts-expect-error the slot name is not registered",
        'href({ to: "/dashboard", slots: { admin: user } })',
        "// @ts-expect-error the target route is outside the allowlist",
        'href({ to: "/dashboard", slots: { inspector: href({ to: "/reports" }) } })',
      ),
    )
    expect(typeErrors(["check.ts"])).toEqual([])
  }, 60_000)

  test("a call that matches the route table compiles, and the result is an Href", () => {
    routes()
    write(
      "check.ts",
      lines(
        'import { type Href, href, type NavigateFunction, rawHref } from "@nifrajs/web"',
        'import type { Route } from "./.nifra/types/routes/+types/reports"',
        "// Nothing but this import brings the table in.",
        "export type Loaded = Route.Params",
        "declare const navigate: NavigateFunction",
        "declare const id: string",
        'export const home = href({ to: "/" })',
        'export const user = href({ to: "/users/:id", params: { id }, search: { tab: "posts" }, hash: "top" })',
        'export const noSearch = href({ to: "/users/:id", params: { id } })',
        'export const reports = href({ to: "/reports", search: { page: 1 } })',
        "// A route without a searchSchema reads the raw query, so any key is its search.",
        'export const loose = href({ to: "/", search: { utm_source: "news", n: 1 } })',
        'export const docs = href({ to: "/docs/:page", params: { page: "intro" } })',
        'export const localized = href({ to: "/:lang/docs/:page", params: { lang: "en", page: "intro" } })',
        'export const file = href({ to: "/files/*path", params: { path: "a/b" } })',
        'export const typed: Href<"/users/:id"> = user',
        "export const widened: Href = user",
        "export const asString: string = user",
        "navigate(user)",
        "navigate(-1)",
        'navigate(rawHref("/llms.txt"))',
        "navigate(user, { replace: true })",
      ),
    )
    expect(typeErrors(["check.ts"])).toEqual([])
  }, 60_000)

  test("a route that is not in the table, a wrong param or a wrong search does not compile", () => {
    routes()
    write(
      "check.ts",
      lines(
        'import { href, rawHref } from "@nifrajs/web"',
        'import type { Route } from "./.nifra/types/routes/+types/reports"',
        "export type Loaded = Route.Params",
        "// @ts-expect-error a misspelt route",
        'export const typo = href({ to: "/user/:id", params: { id: "7" } })',
        "// @ts-expect-error a path is not a pattern",
        'export const concrete = href({ to: "/users/7" })',
        "// @ts-expect-error a param is missing",
        'export const missing = href({ to: "/users/:id" })',
        "// @ts-expect-error a param is misspelt",
        'export const misspelt = href({ to: "/users/:id", params: { ID: "7" } })',
        "// @ts-expect-error a param is extra",
        'export const extra = href({ to: "/users/:id", params: { id: "7", extra: "x" } })',
        "// @ts-expect-error a param is a number",
        'export const number = href({ to: "/users/:id", params: { id: 7 } })',
        "// @ts-expect-error a route without params takes none",
        'export const needless = href({ to: "/", params: { id: "7" } })',
        "// @ts-expect-error the optional segment is a param of the longer route only",
        'export const lang = href({ to: "/docs/:page", params: { lang: "en", page: "a" } })',
        "// @ts-expect-error page is a number",
        'export const wrongSearch = href({ to: "/reports", search: { page: "x" } })',
        "// @ts-expect-error page is required once search is given",
        'export const emptySearch = href({ to: "/reports", search: {} })',
        "// @ts-expect-error the route's schema has no such key",
        'export const unknownKey = href({ to: "/reports", search: { page: 1, extra: 2 } })',
        "// @ts-expect-error the hash is a string",
        'export const wrongHash = href({ to: "/", hash: 5 })',
        "// @ts-expect-error the pattern is not the route this was built for",
        'export const other: import("@nifrajs/web").Href<"/reports"> = href({ to: "/" })',
        "// @ts-expect-error rawHref takes a string",
        "export const notAPath = rawHref(5)",
      ),
    )
    expect(typeErrors(["check.ts"])).toEqual([])
  }, 60_000)

  test("navigate and redirect take an Href, and nothing else", () => {
    routes()
    write(
      "check.ts",
      lines(
        'import { href, type NavigateFunction, rawHref, redirect } from "@nifrajs/web"',
        'import type { Route } from "./.nifra/types/routes/+types/reports"',
        "export type Loaded = Route.Params",
        "declare const navigate: NavigateFunction",
        "declare const id: string",
        "// @ts-expect-error a string literal",
        'navigate("/users/7")',
        "// @ts-expect-error a template literal",
        `navigate(\`/users/\${id}\`)`,
        "// @ts-expect-error a concatenation",
        'navigate("/users/" + id)',
        "// @ts-expect-error a string-typed variable",
        "navigate(id)",
        "// @ts-expect-error the object form is gone",
        'navigate({ to: "/users/:id", params: { id } })',
        "// @ts-expect-error a URL is not an Href",
        'navigate(new URL("https://example.com/"))',
        'redirect(href({ to: "/users/:id", params: { id } }), { status: 308 })',
        'redirect(rawHref("/llms.txt"))',
        'redirect("https://example.com/ok", { external: true })',
        'redirect(href({ to: "/" }), { external: true })',
        "// @ts-expect-error redirect: a string literal",
        'redirect("/users/7")',
        "// @ts-expect-error redirect: a template literal",
        `redirect(\`/users/\${id}\`)`,
        "// @ts-expect-error redirect: a string variable",
        "redirect(id)",
        "// @ts-expect-error redirect: a string needs { external: true }",
        'redirect("https://example.com/ok", { status: 301 })',
        "// @ts-expect-error redirect: external is a literal, so an unchecked flag does not open the string form",
        "redirect(id, { external: id === 'x' })",
      ),
    )
    expect(typeErrors(["check.ts"])).toEqual([])
  }, 60_000)

  test("the errors name the mistake", () => {
    routes()
    write(
      "check.ts",
      lines(
        'import { href } from "@nifrajs/web"',
        'import type { NavigateFunction } from "@nifrajs/web"',
        'import type { Route } from "./.nifra/types/routes/+types/reports"',
        "export type Loaded = Route.Params",
        "declare const navigate: NavigateFunction",
        'href({ to: "/users/:id" })',
        'href({ to: "/users/:id", params: { ID: "7" } })',
        'href({ to: "/reports", search: { page: "x" } })',
        'href({ to: "/user/:id", params: { id: "7" } })',
        'navigate("/users/7")',
      ),
    )
    const errors = typeErrors(["check.ts"])
    const at = (line: number): string =>
      errors.filter((e) => e.startsWith(`check.ts:${line} `)).join(" | ")
    expect(at(6)).toContain("params")
    expect(at(7)).toContain("ID")
    expect(at(8)).toContain("Type 'string' is not assignable to type 'number'")
    expect(at(9)).toContain("/user/:id")
    expect(at(10)).toContain("Href")
  }, 60_000)

  test("an adapter's router entry exports the same checked href()", () => {
    routes()
    write(
      "check.ts",
      lines(
        'import { href, rawHref, useNavigate } from "@nifrajs/web-react/router"',
        'import type { Route } from "./.nifra/types/routes/+types/reports"',
        "export type Loaded = Route.Params",
        "export const navigate = useNavigate()",
        'navigate(href({ to: "/reports", search: { page: 1 } }))',
        'navigate(rawHref("/llms.txt"))',
        "// @ts-expect-error page is a number",
        'navigate(href({ to: "/reports", search: { page: "x" } }))',
        "// @ts-expect-error a string",
        'navigate("/reports")',
      ),
    )
    expect(typeErrors(["check.ts"])).toEqual([])
  }, 60_000)

  test("every adapter exports typed route-slot controls and the Svelte component", () => {
    routes()
    write(
      "check.ts",
      lines(
        'import { href } from "@nifrajs/web"',
        'import { RouteSlot as ReactRouteSlot, useRouteSlot as useReactRouteSlot } from "@nifrajs/web-react/router"',
        'import { RouteSlot as PreactRouteSlot, useRouteSlot as usePreactRouteSlot } from "@nifrajs/web-preact/router"',
        'import { RouteSlot as SolidRouteSlot, useRouteSlot as useSolidRouteSlot } from "@nifrajs/web-solid/router"',
        'import { RouteSlot as VueRouteSlot, useRouteSlot as useVueRouteSlot } from "@nifrajs/web-vue/router"',
        'import SvelteRouteSlot from "@nifrajs/web-svelte/route-slot"',
        'import { useRouteSlot as useSvelteRouteSlot } from "@nifrajs/web-svelte/router"',
        'import type { Route } from "./.nifra/types/routes/+types/dashboard"',
        "export type Loaded = Route.Params",
        'const target = href({ to: "/users/:id", params: { id: "7" } })',
        'useReactRouteSlot("inspector").open(target)',
        'usePreactRouteSlot("inspector").open(target)',
        'useSolidRouteSlot("inspector").open(target)',
        'useVueRouteSlot("inspector").open(target)',
        'useSvelteRouteSlot("inspector").open(target)',
        "void ReactRouteSlot",
        "void PreactRouteSlot",
        "void SolidRouteSlot",
        "void VueRouteSlot",
        "void SvelteRouteSlot",
        "// @ts-expect-error slot names come from the route table",
        'useReactRouteSlot("admin")',
      ),
    )
    expect(typeErrors(["check.ts"])).toEqual([])
  }, 60_000)
})
