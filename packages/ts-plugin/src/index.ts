/**
 * `@nifrajs/ts-plugin` - a TypeScript language-service plugin. It adds ONE thing to the editor:
 * go-to-definition on a route-path string literal jumps to the `routes/` file that serves it, so
 * `navigate({ to: "/orders" })`, `<Link to="/orders">`, or `href="/orders"` are click-through.
 *
 * Wire it up in a project's tsconfig:
 * ```json
 * { "compilerOptions": { "plugins": [{ "name": "@nifrajs/ts-plugin" }] } }
 * ```
 *
 * The routing rules are nifra's own: it discovers routes with `@nifrajs/web`'s `discoverRoutes` and
 * matches with `@nifrajs/core`'s pattern matcher (see ./resolve.ts), so a path resolves to exactly the
 * file it would serve at runtime. The plugin only wires that into `getDefinitionAndBoundSpan`.
 */
import { existsSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { discoverRoutes } from "@nifrajs/web/fs"
import type * as ts from "typescript"
import { resolveRouteFile } from "./resolve.ts"

/** Walk up from a source file to the nearest directory that has a `routes/` folder - the app root. */
export function findRoutesDir(
  fromFile: string,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  let dir = dirname(fromFile)
  for (let i = 0; i < 64; i++) {
    if (exists(join(dir, "routes"))) return join(dir, "routes")
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** The innermost AST node whose span contains `position`. */
function innermostNodeAt(
  tsm: typeof ts,
  source: ts.SourceFile,
  node: ts.Node,
  position: number,
): ts.Node | undefined {
  if (position < node.getStart(source) || position > node.getEnd()) return undefined
  let found: ts.Node = node
  node.forEachChild((child) => {
    const inChild = innermostNodeAt(tsm, source, child, position)
    if (inChild !== undefined) found = inChild
  })
  return found
}

/**
 * If `position` sits on a string-literal route path (`"/..."`), return its text and the span INSIDE the
 * quotes (so the editor highlights the path, not the quotes). Exported for unit testing against a
 * `SourceFile` built with `ts.createSourceFile`.
 */
export function findRoutePathLiteral(
  tsm: typeof ts,
  source: ts.SourceFile,
  position: number,
): { text: string; span: ts.TextSpan } | undefined {
  const node = innermostNodeAt(tsm, source, source, position)
  if (node === undefined || !tsm.isStringLiteralLike(node)) return undefined
  if (!node.text.startsWith("/")) return undefined
  const start = node.getStart(source) + 1 // step past the opening quote
  return { text: node.text, span: { start, length: Math.max(0, node.getWidth(source) - 2) } }
}

/** Build the route go-to-definition for the literal at `position`, or undefined to fall through. */
function routeDefinitionAt(
  tsm: typeof ts,
  ls: ts.LanguageService,
  fileName: string,
  position: number,
): ts.DefinitionInfoAndBoundSpan | undefined {
  const source = ls.getProgram()?.getSourceFile(fileName)
  if (source === undefined) return undefined
  const literal = findRoutePathLiteral(tsm, source, position)
  if (literal === undefined) return undefined
  const routesDir = findRoutesDir(fileName)
  if (routesDir === undefined) return undefined
  let file: string | undefined
  try {
    file = resolveRouteFile(literal.text, discoverRoutes(routesDir).routes)
  } catch {
    return undefined // a routes/ dir that can't be scanned is not this plugin's error to raise
  }
  if (file === undefined) return undefined
  const target = isAbsolute(file) ? file : join(routesDir, file)
  if (!existsSync(target)) return undefined
  return {
    definitions: [
      {
        fileName: target,
        textSpan: { start: 0, length: 0 },
        kind: tsm.ScriptElementKind.moduleElement,
        name: literal.text,
        containerName: "",
        containerKind: tsm.ScriptElementKind.unknown,
      },
    ],
    textSpan: literal.span,
  }
}

function init(modules: { typescript: typeof ts }): ts.server.PluginModule {
  const tsm = modules.typescript
  return {
    create(info: ts.server.PluginCreateInfo): ts.LanguageService {
      const ls = info.languageService
      // Proxy the language service, delegating every method to the real one except the one we augment.
      // Plain ASSIGNMENT (not Object.defineProperty) so each property stays writable - the override
      // below reassigns one, which a non-writable property would reject at runtime.
      const proxy = Object.create(null) as ts.LanguageService
      const writable = proxy as unknown as Record<string, unknown>
      for (const key of Object.keys(ls) as Array<keyof ts.LanguageService>) {
        const member = ls[key]
        writable[key] =
          typeof member === "function"
            ? (member as (...args: unknown[]) => unknown).bind(ls)
            : member
      }
      proxy.getDefinitionAndBoundSpan = (fileName, position) =>
        routeDefinitionAt(tsm, ls, fileName, position) ??
        ls.getDefinitionAndBoundSpan(fileName, position)
      return proxy
    },
  }
}

export default init
