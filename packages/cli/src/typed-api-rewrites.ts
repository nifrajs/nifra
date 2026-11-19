/**
 * The 5.15 source rewrites. Three APIs became typed from the generated route table and the backend, and
 * each old call shape stopped compiling; these rewrite the shapes whose new form is decided by the call
 * alone, and list every other site by line:
 *
 *   - `route-hooks`: `useSearch<T>()` / `useParams<T>()` / the bare calls become `useSearch("/pattern")`,
 *     the pattern being the page file's own route. A call outside a page file (a shared component, a
 *     layout) is listed: only its author knows which route it renders in.
 *   - `query-keys`: `getQueryData(key)` / `setQueryData(key, value)` take a typed key, so a plain key is
 *     wrapped in `queryKey(...)` (its type argument moves onto it).
 *   - `form-for`: `formFor<App, "/path", "method">()` becomes `formFor<App>()("/path", "method")`.
 */
import { buildManifest } from "@nifrajs/web"
import type * as TS from "typescript"
import { importedNames } from "./internal/named-imports.ts"
import {
  applyEdits,
  type Edit,
  type ManualSite,
  parseSource,
  type RewriteResult,
  type SourceRewrite,
} from "./internal/rewrite-kit.ts"

const ADAPTER = /^@nifrajs\/web-(?:react|preact|solid|svelte|vue)(?:\/router)?$/
const WEB_QUERY =
  /^@nifrajs\/web(?:-(?:react|preact|solid|svelte|vue))?(?:\/(?:router|client|query))?$/
const FORMS = /^@nifrajs\/web(?:\/forms)?$/
const SFC = /\.(?:svelte|vue)$/
const PAGE_FILE = /\.(?:tsx|jsx|svelte|vue|mdx)$/

/** The quote the file's own imports use. */
const quoteOf = (text: string): '"' | "'" => (/from\s*'/.test(text) ? "'" : '"')

/** The URL patterns the page file `file` serves, or none when it is not a page of a routes directory. */
function pagePatterns(file: string): readonly string[] {
  const path = file.replaceAll("\\", "/")
  const nested = path.indexOf("/routes/")
  const inside = path.startsWith("routes/")
    ? path.slice("routes/".length)
    : nested === -1
      ? undefined
      : path.slice(nested + "/routes/".length)
  if (inside === undefined || !PAGE_FILE.test(inside)) return []
  try {
    // Only the patterns are read; no route module is ever loaded.
    const never = () => () => Promise.reject(new Error("not loaded"))
    return buildManifest([inside], never).routes.map((route) => route.pattern)
  } catch {
    return []
  }
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length

const HOOK_CALL = /\b(use(?:Search|Params))(?:<[^<>()]*>)?\(\s*\)/g

function rewriteRouteHooks(ts: typeof TS, file: string, text: string): RewriteResult {
  const patterns = pagePatterns(file)
  const only = patterns.length === 1 ? patterns[0] : undefined
  const where =
    patterns.length === 0
      ? 'this file is not a page: name the route it renders in, as in useSearch("/reports") (a component shared by several pages takes the pattern as a prop typed as the union of their routes)'
      : `this page serves ${patterns.map((pattern) => `"${pattern}"`).join(" and ")}: name the one it reads`
  if (SFC.test(file)) {
    const manual: ManualSite[] = []
    for (const match of text.matchAll(HOOK_CALL))
      manual.push({
        line: lineAt(text, match.index),
        reason: `${match[0]} takes the route: ${only === undefined ? where : `write ${match[1]}("${only}")`}`,
      })
    return { text, count: 0, manual }
  }
  const { tree, lineOf } = parseSource(ts, file, text)
  const names = importedNames(ts, tree, ADAPTER, ["useSearch", "useParams"])
  if (names.size === 0) return { text, count: 0, manual: [] }
  const quote = quoteOf(text)
  const edits: Edit[] = []
  const manual: ManualSite[] = []
  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const hook = names.get(node.expression.text)
      if (hook !== undefined && node.arguments.length === 0) {
        if (only === undefined)
          manual.push({ line: lineOf(node), reason: `${hook}() takes the route: ${where}` })
        else
          edits.push({
            start: node.expression.end,
            end: node.end,
            text: `(${quote}${only}${quote})`,
          })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return { text: applyEdits(text, edits), count: edits.length, manual }
}

const QUERY_KEY = "queryKey"
const KEYED = new Set(["getQueryData", "setQueryData"])

function rewriteQueryKeys(ts: typeof TS, file: string, text: string): RewriteResult {
  if (SFC.test(file)) return { text, count: 0, manual: [] }
  const { tree } = parseSource(ts, file, text)
  const fromWeb = tree.statements.filter(
    (statement): statement is TS.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      WEB_QUERY.test(statement.moduleSpecifier.text),
  )
  // The calls are unqualified in name (`qc.setQueryData`), so only a file that holds a Nifra query
  // client is read: TanStack's client has the same method names and a different key type.
  const tanstack = tree.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith("@tanstack/"),
  )
  if (fromWeb.length === 0 || tanstack) return { text, count: 0, manual: [] }
  const local = importedNames(ts, tree, WEB_QUERY, [QUERY_KEY]).keys().next().value ?? QUERY_KEY
  const edits: Edit[] = []
  let sites = 0
  const visit = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      KEYED.has(node.expression.name.text)
    ) {
      const [key] = node.arguments
      const alreadyKeyed =
        key !== undefined &&
        ts.isCallExpression(key) &&
        ts.isIdentifier(key.expression) &&
        key.expression.text === local
      if (key !== undefined && !alreadyKeyed) {
        sites++
        const typeArgs = node.typeArguments
        const generic =
          typeArgs === undefined ? "" : `<${typeArgs.map((arg) => arg.getText(tree)).join(", ")}>`
        if (typeArgs !== undefined)
          edits.push({ start: node.expression.name.end, end: key.getStart(tree), text: "(" })
        edits.push({
          start: key.getStart(tree),
          end: key.end,
          text: `${local}${generic}(${key.getText(tree)})`,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (edits.length === 0) return { text, count: 0, manual: [] }
  const needsImport = importedNames(ts, tree, WEB_QUERY, [QUERY_KEY]).size === 0
  if (needsImport) {
    const quote = quoteOf(text)
    const last = tree.statements.filter(ts.isImportDeclaration).at(-1)
    const line = `import { ${QUERY_KEY} } from ${quote}@nifrajs/web/client${quote}`
    edits.push(
      last === undefined
        ? { start: 0, end: 0, text: `${line}\n` }
        : { start: last.end, end: last.end, text: `\n${line}` },
    )
  }
  return { text: applyEdits(text, edits), count: sites, manual: [] }
}

function rewriteFormFor(ts: typeof TS, file: string, text: string): RewriteResult {
  if (SFC.test(file)) return { text, count: 0, manual: [] }
  const { tree, lineOf } = parseSource(ts, file, text)
  const names = importedNames(ts, tree, FORMS, ["formFor"])
  if (names.size === 0) return { text, count: 0, manual: [] }
  const edits: Edit[] = []
  const manual: ManualSite[] = []
  const literal = (node: TS.TypeNode | undefined): string | undefined =>
    node !== undefined && ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)
      ? node.literal.getText(tree)
      : undefined
  const visit = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.has(node.expression.text) &&
      (node.typeArguments?.length ?? 0) >= 2
    ) {
      const [app, path, method] = node.typeArguments ?? []
      const pathText = literal(path)
      const methodText = literal(method)
      if (
        app === undefined ||
        pathText === undefined ||
        (method !== undefined && methodText === undefined)
      )
        manual.push({
          line: lineOf(node),
          reason:
            'formFor<App, Path>() is now formFor<App>()("/path", "method"): the path and method are values, so write them as literals',
        })
      else
        edits.push({
          start: node.getStart(tree),
          end: node.end,
          text: `${node.expression.text}<${app.getText(tree)}>()(${pathText}${methodText === undefined ? "" : `, ${methodText}`})`,
        })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return { text: applyEdits(text, edits), count: edits.length, manual }
}

export const TYPED_API_REWRITES: readonly SourceRewrite[] = [
  {
    id: "route-hooks",
    description:
      'useSearch<T>() / useParams<T>() and the bare calls → useSearch("/pattern") / useParams("/pattern") in a page file',
    mentions: (text) => /\buse(?:Search|Params)\b/.test(text) && /@nifrajs\/web-/.test(text),
    rewrite: rewriteRouteHooks,
  },
  {
    id: "query-keys",
    description: "getQueryData(key) / setQueryData(key, v) → the same with queryKey(key)",
    mentions: (text) => /\b(?:get|set)QueryData\b/.test(text) && /@nifrajs\/web/.test(text),
    rewrite: rewriteQueryKeys,
  },
  {
    id: "form-for",
    description: 'formFor<App, "/path">() → formFor<App>()("/path")',
    mentions: (text) => /\bformFor\b/.test(text) && /@nifrajs\/web/.test(text),
    rewrite: rewriteFormFor,
  },
]
