/**
 * A navigation target is an `Href`, built by `href()` or `rawHref()`. This walks everything the six web
 * packages export from their client-facing entries (`.`, `./client`, `./router`) and fails on a
 * parameter or property named `to`, `href` or `location` whose type accepts a plain `string`:
 * a new one is a way around the route table, and either takes an `Href` or is listed in ALLOWED with
 * the reason a string is right there. An entry whose declaration is gone fails until it is removed.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const ROOT = join(import.meta.dir, "..", "..", "..")
const PACKAGES = ["web", "web-react", "web-preact", "web-solid", "web-svelte", "web-vue"]
const ENTRIES = [".", "./client", "./router"]
const TARGET_NAMES = new Set(["to", "href", "location"])

/** Declarations that take a string on purpose, by `file#export.member`: how many, and why. */
const ALLOWED: Readonly<Record<string, { readonly count: number; readonly reason: string }>> = {
  "packages/web/src/internal/render-document.ts#redirect.location": {
    count: 2,
    reason:
      "the `{ external: true }` overload, whose target is another origin, and the implementation signature; an in-app target takes the Href overload",
  },
  "packages/web/src/navigation.ts#BrowserNavigate.to": {
    count: 1,
    reason:
      "the bridge `installHistory` registers: `useNavigate` hands out the Href-typed NavigateFunction, and the bridge re-checks every string with sameDocumentUrl",
  },
  "packages/web-react/src/router.ts#Navigation.location": {
    count: 1,
    reason:
      "the pending navigation's target as `useNavigation` reports it: read by an app, never passed in",
  },
  "packages/web/src/boundary.ts#StaticBoundaryImportEdge.to": {
    count: 1,
    reason: "a module path in a build-time import-graph diagnostic",
  },
  "packages/web/src/fonts.ts#FontPreloadInput.href": {
    count: 1,
    reason: 'the URL of a font file for `<link rel="preload">`',
  },
  "packages/web/src/internal/web-app.ts#WebAppI18n.location": {
    count: 1,
    reason: "the Location header an i18n redirect produced, handed back to the framework",
  },
  "packages/web/src/manifest.ts#LinkDescriptor.href": {
    count: 1,
    reason:
      "the URL of a `<link>` tag in `meta` (stylesheet, icon, canonical), not a navigation target",
  },
  "packages/web/src/seo.ts#canonical.href": {
    count: 1,
    reason: 'the absolute URL of a `<link rel="canonical">`, not a target inside the app',
  },
}

/** The `bun` condition of a package export: the source file the entry is written in. */
function entryFile(pkg: string, entry: string): string | undefined {
  // JSON.parse is `any`: the annotation is the shape this reads, with no cast.
  const { exports }: { exports: Record<string, string | { bun?: string }> } = JSON.parse(
    readFileSync(join(ROOT, "packages", pkg, "package.json"), "utf8"),
  )
  const target = exports[entry]
  const path = typeof target === "string" ? target : target?.bun
  return path === undefined ? undefined : join(ROOT, "packages", pkg, path)
}

/** Does this type annotation accept a plain `string`? */
function acceptsString(type: ts.TypeNode | undefined): boolean {
  if (type === undefined) return false
  if (type.kind === ts.SyntaxKind.StringKeyword || ts.isTemplateLiteralTypeNode(type)) return true
  if (ts.isParenthesizedTypeNode(type)) return acceptsString(type.type)
  if (ts.isUnionTypeNode(type)) return type.types.some(acceptsString)
  return false
}

function stringTargets(): Map<string, number> {
  const roots = PACKAGES.flatMap((pkg) => ENTRIES.map((entry) => entryFile(pkg, entry))).filter(
    (file): file is string => file !== undefined && existsSync(file),
  )
  const program = ts.createProgram(roots, {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowImportingTsExtensions: true,
    types: [],
  })
  const checker = program.getTypeChecker()
  const found = new Map<string, number>()
  const seen = new Set<ts.Node>()
  for (const root of roots) {
    const source = program.getSourceFile(root)
    const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source)
    if (moduleSymbol === undefined) continue
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
      for (const declaration of symbol.declarations ?? []) {
        if (seen.has(declaration)) continue
        seen.add(declaration)
        const file = declaration.getSourceFile()
        if (!file.fileName.startsWith(join(ROOT, "packages"))) continue
        const visit = (node: ts.Node): void => {
          if (ts.isBlock(node)) return // a body is the implementation, not the signature a caller sees
          if (
            (ts.isParameter(node) ||
              ts.isPropertySignature(node) ||
              ts.isPropertyDeclaration(node)) &&
            ts.isIdentifier(node.name) &&
            TARGET_NAMES.has(node.name.text) &&
            acceptsString(node.type)
          ) {
            const key = `${relative(ROOT, file.fileName)}#${symbol.name}.${node.name.text}`
            found.set(key, (found.get(key) ?? 0) + 1)
          }
          ts.forEachChild(node, visit)
        }
        visit(declaration)
      }
    }
  }
  return found
}

test("no exported navigation surface takes a plain string target", () => {
  const found = stringTargets()
  const unexpected = [...found]
    .filter(([key, count]) => ALLOWED[key]?.count !== count)
    .map(([key, count]) => `${key}: ${count} (allowed ${ALLOWED[key]?.count ?? 0})`)
  const stale = Object.keys(ALLOWED).filter((key) => !found.has(key))
  expect({ unexpected: unexpected.sort(), stale }).toEqual({ unexpected: [], stale: [] })
}, 60_000)
