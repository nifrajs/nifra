import { expect, test } from "bun:test"
import ts from "typescript"
import { findRoutePathLiteral, findRoutesDir } from "../src/index.ts"
import { resolveRouteFile } from "../src/resolve.ts"

const ROUTES = [
  { pattern: "/", file: "routes/index.tsx" },
  { pattern: "/about", file: "routes/about.tsx" },
  { pattern: "/users/:id", file: "routes/users/[id].tsx" },
]

test("resolveRouteFile maps a concrete path to its route file via nifra's matcher", () => {
  expect(resolveRouteFile("/", ROUTES)).toBe("routes/index.tsx")
  expect(resolveRouteFile("/about", ROUTES)).toBe("routes/about.tsx")
  expect(resolveRouteFile("/users/42", ROUTES)).toBe("routes/users/[id].tsx")
})

test("resolveRouteFile ignores query/hash and rejects non-paths and non-matches", () => {
  expect(resolveRouteFile("/about?tab=x", ROUTES)).toBe("routes/about.tsx")
  expect(resolveRouteFile("/about#top", ROUTES)).toBe("routes/about.tsx")
  expect(resolveRouteFile("/nope", ROUTES)).toBeUndefined()
  expect(resolveRouteFile("not-a-path", ROUTES)).toBeUndefined()
  expect(resolveRouteFile("", ROUTES)).toBeUndefined()
})

const sourceOf = (code: string): ts.SourceFile =>
  ts.createSourceFile("fixture.tsx", code, ts.ScriptTarget.Latest, /* setParentNodes */ true)

test("findRoutePathLiteral returns a path literal and the span INSIDE its quotes", () => {
  const code = 'const go = () => navigate({ to: "/users/42" })'
  const source = sourceOf(code)
  const at = code.indexOf("/users/42") + 3 // cursor mid-literal
  const found = findRoutePathLiteral(ts, source, at)
  expect(found?.text).toBe("/users/42")
  // The span excludes the quotes, so the editor underlines just the path.
  expect(code.slice(found!.span.start, found!.span.start + found!.span.length)).toBe("/users/42")
})

test("findRoutePathLiteral ignores non-path literals and positions off any literal", () => {
  const code = 'const label = "hello"; const n = 42'
  const source = sourceOf(code)
  expect(findRoutePathLiteral(ts, source, code.indexOf("hello"))).toBeUndefined()
  expect(findRoutePathLiteral(ts, source, code.indexOf("42"))).toBeUndefined()
})

test("findRoutesDir walks up to the nearest directory containing routes/", () => {
  const has = (p: string): boolean => p === "/app/routes"
  expect(findRoutesDir("/app/routes/about.tsx", has)).toBe("/app/routes")
  expect(findRoutesDir("/app/src/deep/component.tsx", has)).toBe("/app/routes")
  expect(findRoutesDir("/elsewhere/file.ts", () => false)).toBeUndefined()
})
