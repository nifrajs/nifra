import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import ts from "typescript"
import plugin, { findRoutePathLiteral, findRoutesDir } from "../src/index.ts"
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

test("resolveRouteFile applies runtime specificity instead of manifest order", () => {
  const routes = [
    { pattern: "/users/:id", file: "routes/users/[id].tsx" },
    { pattern: "/users/new", file: "routes/users/new.tsx" },
  ]
  expect(resolveRouteFile("/users/new", routes)).toBe("routes/users/new.tsx")
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
  const routes = join(resolve("/app"), "routes")
  const has = (p: string): boolean => p === routes
  expect(findRoutesDir(join(routes, "about.tsx"), has)).toBe(routes)
  expect(findRoutesDir(join(resolve("/app"), "src", "deep", "component.tsx"), has)).toBe(routes)
  expect(findRoutesDir("/elsewhere/file.ts", () => false)).toBeUndefined()
})

// End-to-end wiring: the default-export plugin factory, its language-service proxy, and
// `routeDefinitionAt` (the on-disk glue). Everything above tests the pure helpers in isolation;
// this drives the real `create()` path against a real `ts.LanguageService` over a temp app.
const root = mkdtempSync(join(tmpdir(), "nifra-ts-plugin-"))
mkdirSync(join(root, "routes"), { recursive: true })
writeFileSync(join(root, "routes", "about.tsx"), "export default function About() {}\n")
const srcPath = join(root, "app.tsx")
const appCode = 'const go = () => navigate({ to: "/about" })\n'
writeFileSync(srcPath, appCode)

afterAll(() => rmSync(root, { recursive: true, force: true }))

function makeLanguageService(): ts.LanguageService {
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [srcPath],
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) =>
      f.toLowerCase() === srcPath.toLowerCase() ? ts.ScriptSnapshot.fromString(appCode) : undefined,
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({ jsx: ts.JsxEmit.ReactJSX, allowJs: true }),
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }
  return ts.createLanguageService(host, ts.createDocumentRegistry())
}

const createProxy = (ls: ts.LanguageService): ts.LanguageService =>
  plugin({ typescript: ts }).create({
    languageService: ls,
  } as unknown as ts.server.PluginCreateInfo)

test("the plugin proxy sends go-to-definition on a route literal to its routes/ file", () => {
  const proxy = createProxy(makeLanguageService())
  const pos = appCode.indexOf("/about") + 2 // cursor inside the literal
  const def = proxy.getDefinitionAndBoundSpan(srcPath, pos)
  expect(def?.definitions?.[0]?.fileName).toBe(join(root, "routes", "about.tsx"))
  // The bound span underlines the path, not the quotes.
  const { start, length } = def!.textSpan
  expect(appCode.slice(start, start + length)).toBe("/about")
})

test("the plugin proxy delegates untouched methods and falls through off a route literal", () => {
  const real = makeLanguageService()
  const proxy = createProxy(real)
  // A non-augmented method is bound straight to the real service.
  expect(Array.isArray(proxy.getSyntacticDiagnostics(srcPath))).toBe(true)
  // A position not on a route literal yields no route definition - the plugin defers to the host.
  const def = proxy.getDefinitionAndBoundSpan(srcPath, appCode.indexOf("go"))
  expect(def?.definitions?.some((d) => d.fileName.endsWith("routes/about.tsx"))).not.toBe(true)
})
