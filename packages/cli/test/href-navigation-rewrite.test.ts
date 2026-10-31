import { describe, expect, test } from "bun:test"
import ts from "typescript"
import { getSourceRewrite } from "../src/source-rewrites.ts"

const rewrite = (text: string, file = "app.tsx") => {
  const hrefNavigation = getSourceRewrite("href-navigation")
  if (hrefNavigation === undefined) throw new Error("the href-navigation rewrite is registered")
  return hrefNavigation.rewrite(ts, file, text)
}

const BUILT =
  "the destination is built from a string: build it with href({ to, params, search }), or wrap a path built elsewhere in rawHref(path)"

describe("href-navigation rewrite", () => {
  test("a string path at navigate, redirect, Link, NavLink and Navigate becomes rawHref(path)", () => {
    const result =
      rewrite(`import { Link, Navigate, NavLink, useNavigate } from "@nifrajs/web-react/router"
import { redirect } from "@nifrajs/web"

export function Menu() {
  const navigate = useNavigate()
  navigate("/users/7")
  navigate(\`/pricing\`, { replace: true })
  navigate(-1)
  return (
    <nav>
      <Link to="/about" className="x">About</Link>
      <NavLink to={"/docs"}>Docs</NavLink>
      <Navigate to='/login' replace />
    </nav>
  )
}

export const guard = () => redirect("/login", { status: 302 })
`)
    expect(
      result.text,
    ).toBe(`import { Link, NavLink, Navigate, rawHref, useNavigate } from "@nifrajs/web-react/router"
import { redirect } from "@nifrajs/web"

export function Menu() {
  const navigate = useNavigate()
  navigate(rawHref("/users/7"))
  navigate(rawHref(\`/pricing\`), { replace: true })
  navigate(-1)
  return (
    <nav>
      <Link to={rawHref("/about")} className="x">About</Link>
      <NavLink to={rawHref("/docs")}>Docs</NavLink>
      <Navigate to={rawHref("/login")} replace />
    </nav>
  )
}

export const guard = () => redirect(rawHref("/login"), { status: 302 })
`)
    expect(result.count).toBe(6)
    expect(result.manual).toEqual([])
  })

  test("redirect takes rawHref from @nifrajs/web, and an existing rawHref import is reused under its name", () => {
    const fromWeb = rewrite(`import { redirect } from "@nifrajs/web"
export const go = () => redirect("/login")
`)
    expect(fromWeb.text).toBe(`import { rawHref, redirect } from "@nifrajs/web"
export const go = () => redirect(rawHref("/login"))
`)
    const aliased = rewrite(`import { rawHref as path, redirect } from "@nifrajs/web"
export const go = () => redirect("/login")
`)
    expect(aliased.text).toBe(`import { rawHref as path, redirect } from "@nifrajs/web"
export const go = () => redirect(path("/login"))
`)
  })

  test("a multi-line import keeps its lines, and a single-quote file gets single-quote strings", () => {
    const result = rewrite(
      `import {
  Link,
  useNavigate,
} from '@nifrajs/web-react/router'

export const A = () => <Link to="/about">About</Link>
`,
    )
    expect(result.text).toBe(`import {
  Link,
  rawHref,
  useNavigate,
} from '@nifrajs/web-react/router'

export const A = () => <Link to={rawHref('/about')}>About</Link>
`)
  })

  test("a destination built from a string, an object and a path rawHref refuses are listed by their line in the new file", () => {
    const result = rewrite(`import {
  useNavigate,
} from "@nifrajs/web-react/router"
import { redirect } from "@nifrajs/web"

export function Go({ id, next }: { id: string; next: string }) {
  const navigate = useNavigate()
  navigate(\`/users/\${id}\`)
  navigate("/users/" + id)
  navigate({ to: "/search", search: { q: "a" }, replace: true })
  navigate(next)
  navigate("https://example.com")
  redirect("//evil.example")
}
`)
    expect(result.count).toBe(0)
    expect(result.text).toBe(`import {
  useNavigate,
} from "@nifrajs/web-react/router"
import { redirect } from "@nifrajs/web"

export function Go({ id, next }: { id: string; next: string }) {
  const navigate = useNavigate()
  navigate(\`/users/\${id}\`)
  navigate("/users/" + id)
  navigate({ to: "/search", search: { q: "a" }, replace: true })
  navigate(next)
  navigate("https://example.com")
  redirect("//evil.example")
}
`)
    expect(result.manual).toEqual([
      { line: 8, reason: BUILT },
      { line: 9, reason: BUILT },
      {
        line: 10,
        reason:
          "navigate({ to, search, replace }) is navigate(href({ to, search }), { replace }): the route and its params are the app's to name",
      },
      {
        line: 12,
        reason:
          '"https://example.com" is not a same-origin path, which an Href must be: another site is a plain <a href>, or redirect(url, { external: true })',
      },
      {
        line: 13,
        reason:
          '"//evil.example" is not a same-origin path, which an Href must be: another site is a plain <a href>, or redirect(url, { external: true })',
      },
    ])
  })

  test("manual lines follow the lines an import rewritten across several lines adds", () => {
    const result = rewrite(`import {
  Link,
  useNavigate,
} from "@nifrajs/web-react/router"

export const A = ({ id }: { id: string }) => (
  <>
    <Link to="/a">a</Link>
    <Link to={\`/b/\${id}\`}>b</Link>
  </>
)
`)
    expect(result.count).toBe(1)
    expect(result.manual).toEqual([{ line: 10, reason: BUILT }])
    expect(result.text.split("\n")[9]).toContain(`/b/\${id}`)
  })

  test("redirect with external, an Href already built, and other libraries' calls are left alone", () => {
    const text = `import { href, rawHref, useNavigate } from "@nifrajs/web-react/router"
import { redirect } from "@nifrajs/web"
import { Link } from "some-router"

export function Go() {
  const navigate = useNavigate()
  const other = useThing()
  navigate(href({ to: "/a" }))
  navigate(rawHref("/b"))
  other("/c")
  redirect("https://example.com", { external: true })
  return <Link to="/d">d</Link>
}
`
    const result = rewrite(text)
    expect(result.text).toBe(text)
    expect(result.count).toBe(0)
    expect(result.manual).toEqual([])
  })

  test("a rewritten file is a fixed point", () => {
    const once = rewrite(`import { Link, useNavigate } from "@nifrajs/web-react/router"
export function A() {
  const navigate = useNavigate()
  navigate("/a")
  return <Link to="/b">b</Link>
}
`)
    expect(once.count).toBe(2)
    const twice = rewrite(once.text)
    expect(twice.text).toBe(once.text)
    expect(twice.count).toBe(0)
  })

  test("a file with a rawHref of its own is listed, not rewritten", () => {
    const result = rewrite(`import { redirect } from "@nifrajs/web"
const rawHref = (path: string) => path
export const go = () => redirect("/login", { status: 302 })
`)
    expect(result.count).toBe(0)
    expect(result.manual).toEqual([
      { line: 3, reason: "rawHref is already a name in this file: import it under another name" },
    ])
  })

  test("a JSX string with an entity or an escape is listed, since a JavaScript string reads it differently", () => {
    const result = rewrite(`import { Link } from "@nifrajs/web-react/router"
export const A = () => <Link to="/a?x=1&amp;y=2">a</Link>
`)
    expect(result.count).toBe(0)
    expect(result.manual).toEqual([
      { line: 2, reason: "wrap the path in rawHref(path), written as a JavaScript string" },
    ])
  })

  test("only a project that imports the navigation API from nifra is parsed", () => {
    const hrefNavigation = getSourceRewrite("href-navigation")
    expect(hrefNavigation?.mentions('import { redirect } from "@nifrajs/web"')).toBe(true)
    expect(hrefNavigation?.mentions('import { redirect } from "express"')).toBe(false)
    expect(hrefNavigation?.mentions('import { x } from "@nifrajs/web"')).toBe(false)
  })
})
