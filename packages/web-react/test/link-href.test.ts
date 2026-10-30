import { expect, spyOn, test } from "bun:test"
import { type Href, href, rawHref } from "@nifrajs/web"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Link, Navigate, NavLink } from "../src/router.ts"

// Augment the route table as `nifra types` does. Patterns no other test in this program uses, so the
// per-compilation augmentation collides with nothing. The `@ts-expect-error` lines are verified by the
// typecheck gate: if a mistake ever stopped being an error, tsc would fail on the unused marker.
declare module "@nifrajs/web" {
  interface RouteTable {
    "/link-users/:id": {
      readonly params: { readonly id: string }
      readonly search: { readonly tab?: string }
    }
    "/link-home": {
      readonly params: Record<string, never>
      readonly search: Record<string, unknown>
    }
  }
}

declare const id: string

// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the point of these tests is a value no href() or rawHref() call made
const forged = (value: string): Href => value as Href

const FORGED = [
  "javascript:alert(1)",
  "//evil.example/x",
  "https://evil.example/",
  "/\\evil.example",
  "/\t/evil.example",
  "/\n/evil.example",
  "/.//evil.example/x",
  "data:text/html,x",
  "#top",
  "users",
  "",
]

test("I10: Link and NavLink render a built Href as the anchor's href", () => {
  const user = href({
    to: "/link-users/:id",
    params: { id: "a b/c" },
    search: { tab: "posts" },
    hash: "top",
  })
  expect(renderToStaticMarkup(createElement(Link, { to: user }, "u"))).toContain(
    'href="/link-users/a%20b%2Fc?tab=posts#top"',
  )
  expect(renderToStaticMarkup(createElement(NavLink, { to: rawHref("/llms.txt") }, "l"))).toContain(
    'href="/llms.txt"',
  )
})

test("I10: Link and NavLink given a forged Href render no href and log it, never throw", () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    for (const value of FORGED) {
      const to = forged(value)
      errors.mockClear()
      expect(renderToStaticMarkup(createElement(Link, { to }, "x"))).toBe("<a>x</a>")
      expect(errors).toHaveBeenCalledTimes(1)
      errors.mockClear()
      expect(renderToStaticMarkup(createElement(NavLink, { to }, "x"))).not.toContain("href=")
      expect(errors).toHaveBeenCalledTimes(1)
      expect(String(errors.mock.calls[0]?.[1])).toContain("same-origin")
    }
  } finally {
    errors.mockRestore()
  }
})

// Compiled, never called: the calls below only have to type-check (or fail to, where marked).
export function typeChecks(): void {
  const home = href({ to: "/link-home" })
  createElement(Link, { to: home })
  createElement(NavLink, { to: home, end: true })
  createElement(Navigate, { to: home, replace: true })
  createElement(Link, { to: href({ to: "/link-users/:id", params: { id } }) })

  // @ts-expect-error a string literal
  createElement(Link, { to: "/link-users/7" })
  // @ts-expect-error a template literal
  createElement(Link, { to: `/link-users/${id}` })
  // @ts-expect-error a concatenation
  createElement(Link, { to: "/link-users/" + id })
  // @ts-expect-error a string variable
  createElement(Link, { to: id })
  // @ts-expect-error the object form
  createElement(Link, { to: { to: "/link-users/:id", params: { id } } })
  // @ts-expect-error a URL
  createElement(Link, { to: new URL("https://example.com/") })
  // @ts-expect-error a string literal
  createElement(NavLink, { to: "/link-home" })
  // @ts-expect-error a template literal
  createElement(NavLink, { to: `/link-users/${id}` })
  // @ts-expect-error a string literal
  createElement(Navigate, { to: "/link-home" })
  // @ts-expect-error a template literal
  createElement(Navigate, { to: `/link-users/${id}` })
  // @ts-expect-error a missing param is caught where the Href is built
  createElement(Link, { to: href({ to: "/link-users/:id" }) })
  // @ts-expect-error a route the app does not have
  createElement(Link, { to: href({ to: "/nope" }) })
}

test("the type checks are compiled by the typecheck gate", () => {
  expect(typeof typeChecks).toBe("function")
})
