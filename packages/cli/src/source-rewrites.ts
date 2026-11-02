/**
 * Source rewrites an upgrade recipe names: the edits an import move cannot express, made on the
 * syntax tree with the project's own TypeScript. A rewrite changes only a shape it recognizes whole
 * and lists every other site for the user to edit by hand; it never guesses.
 */
import { isSameOriginPath } from "@nifrajs/core/pattern"
import type * as TS from "typescript"
import { codeUnitOrder } from "./internal/code-unit-order.ts"
import { scriptKindOf } from "./internal/script-kind.ts"

/** A site a rewrite found and left alone, with what to write instead. */
export interface ManualSite {
  readonly line: number
  readonly reason: string
}

export interface RewriteResult {
  readonly text: string
  /** Sites rewritten. */
  readonly count: number
  readonly manual: readonly ManualSite[]
}

export interface SourceRewrite {
  readonly id: string
  /** What it rewrites, for the plan. */
  readonly description: string
  /** Whether `text` may hold a site: a file it refuses is never parsed. */
  readonly mentions: (text: string) => boolean
  readonly rewrite: (ts: typeof TS, file: string, text: string) => RewriteResult
}

interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** Apply `edits` (disjoint ranges) to `text`, from the end so earlier offsets stay valid. */
function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`
  }
  return out
}

const WEB = "@nifrajs/web"
const NODE = "@nifrajs/node"
const DENO = "@nifrajs/deno"
const CORE_STATIC = "@nifrajs/core/serve-static"
const DAY = "public, max-age=86400"
const YEAR = "public, max-age=31536000, immutable"
const PUBLIC_DIR_KEYS = new Set(["dir", "hashedPrefix", "hashedFiles", "cache", "files"])
const PUBLIC_DIR_FORM =
  'serveStatic({ dir, prefix: "/", fallthrough: true, hashedFiles: (path) => path.startsWith("/assets/"), cacheControl: ONE_DAY })'

type Runtime = "core" | "node" | "deno"

/** The named imports of one module: the declaration, and each imported name's local binding. */
interface ModuleImport {
  readonly declaration: TS.ImportDeclaration
  readonly named: TS.NamedImports | undefined
  readonly locals: Map<string, string>
}

function propertyName(ts: typeof TS, name: TS.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
}

/**
 * 5.9: `servePublicDir` (removed from `@nifrajs/web`) becomes the runtime's `serveStatic` with the
 * options that keep its answers; `@nifrajs/node`'s `static` mount objects are wrapped in
 * `serveStatic()`; and `signals` on `@nifrajs/node`'s and `@nifrajs/deno`'s `serve()` becomes
 * `gracefulSignals`.
 */
/** Parse `text` as `file`, with the line lookup a rewrite lists its manual sites by. */
function parseSource(ts: typeof TS, file: string, text: string) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(ts, file))
  const lineOf = (node: TS.Node): number =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
  return { tree, lineOf }
}

/** Named-import order: by the imported name, a `type` modifier aside. */
const specifierOrder = (a: string, b: string): number =>
  codeUnitOrder(a.replace(/^type /, ""), b.replace(/^type /, ""))

/** The quote most of the file's string literals use, apart from module specifiers and JSX attributes
 * (double-quoted in files whose code is not); `fallback` on a tie. */
function quoteOf(ts: typeof TS, tree: TS.SourceFile, fallback: "'" | '"'): "'" | '"' {
  let single = 0
  let double = 0
  const visit = (node: TS.Node): void => {
    if (
      ts.isStringLiteral(node) &&
      !ts.isJsxAttribute(node.parent) &&
      !ts.isImportDeclaration(node.parent) &&
      !ts.isExportDeclaration(node.parent)
    ) {
      if (node.getText(tree).startsWith("'")) single++
      else double++
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return single === double ? fallback : single > double ? "'" : '"'
}

function rewriteServeStatic(ts: typeof TS, file: string, text: string): RewriteResult {
  const { tree, lineOf } = parseSource(ts, file, text)
  const importQuote = /from\s*'/.test(text) ? "'" : '"'
  const quote = quoteOf(ts, tree, importQuote)
  const edits: Edit[] = []
  const manual: ManualSite[] = []
  let count = 0
  const source = (node: TS.Node): string => node.getText(tree)
  const imports = new Map<string, ModuleImport>()
  // Every import of @nifrajs/web, with the specifiers of names 5.9 moved out of it.
  const webImports: {
    readonly declaration: TS.ImportDeclaration
    readonly named: TS.NamedImports
  }[] = []
  const publicDirSpecifiers = new Set<TS.ImportSpecifier>()
  const hashedFilesSpecifiers = new Set<TS.ImportSpecifier>()
  // A servePublicDir site left for the user keeps its import.
  let publicDirLeft = false
  let publicDir: string | undefined
  let hashedFilesLocal: string | undefined

  for (const statement of tree.statements) {
    if (ts.isExportDeclaration(statement)) {
      const from = statement.moduleSpecifier
      if (from !== undefined && ts.isStringLiteral(from) && from.text === WEB) {
        const names = source(statement)
        if (/\b(?:servePublicDir|ServePublicDirOptions|PublicDirCache|HashedFiles)\b/.test(names)) {
          manual.push({
            line: lineOf(statement),
            reason: `re-exports from ${WEB} a name 5.9 removed: re-export serveStatic, ServeStaticOptions or HashedFiles from ${CORE_STATIC}`,
          })
        }
      }
      continue
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const from = statement.moduleSpecifier.text
    const clause = statement.importClause
    const bindings = clause?.namedBindings
    const named = bindings !== undefined && ts.isNamedImports(bindings) ? bindings : undefined
    const locals = new Map<string, string>()
    for (const element of named?.elements ?? []) {
      locals.set((element.propertyName ?? element.name).text, element.name.text)
    }
    if (!imports.has(from)) imports.set(from, { declaration: statement, named, locals })
    if (from !== WEB) continue
    if (named !== undefined) webImports.push({ declaration: statement, named })
    if (
      bindings !== undefined &&
      ts.isNamespaceImport(bindings) &&
      text.includes("servePublicDir")
    ) {
      publicDirLeft = true
      manual.push({
        line: lineOf(statement),
        reason: `servePublicDir through a namespace import of ${WEB}: call ${PUBLIC_DIR_FORM} from ${CORE_STATIC}`,
      })
    }
    for (const element of named?.elements ?? []) {
      const imported = (element.propertyName ?? element.name).text
      if (imported === "servePublicDir") {
        publicDir = element.name.text
        publicDirSpecifiers.add(element)
      } else if (imported === "HashedFiles") {
        hashedFilesLocal = element.name.text
        hashedFilesSpecifiers.add(element)
      } else if (imported === "ServePublicDirOptions" || imported === "PublicDirCache") {
        manual.push({
          line: lineOf(element),
          reason: `${imported} is removed: type the options as ServeStaticOptions from ${CORE_STATIC}, whose fields differ (prefix, fallthrough, hashedFiles, cacheControl)`,
        })
      }
    }
  }

  const nodeServe = new Set(
    [...(imports.get(NODE)?.locals ?? [])].filter(([name]) => name === "serve").map(([, l]) => l),
  )
  const denoServe = new Set(
    [...(imports.get(DENO)?.locals ?? [])].filter(([name]) => name === "serve").map(([, l]) => l),
  )
  // The file's runtime: a module that serves on Node or Deno gets that adapter's reader.
  const runtime: Runtime = imports.has(NODE) ? "node" : imports.has(DENO) ? "deno" : "core"
  const runtimeModule = runtime === "node" ? NODE : runtime === "deno" ? DENO : CORE_STATIC
  const bound = new Set<string>()
  const collect = (node: TS.Node): void => {
    if (ts.isIdentifier(node)) bound.add(node.text)
    ts.forEachChild(node, collect)
  }
  collect(tree)
  // The local name of the runtime's serveStatic, or `undefined` when the name is taken by another binding.
  const existingStatic = imports.get(runtimeModule)?.locals.get("serveStatic")
  const staticName =
    existingStatic ?? (bound.has("serveStatic") ? undefined : ("serveStatic" as const))
  const coreDay = runtime === "core" && !bound.has("ONE_DAY")
  let staticUsed = false
  let dayUsed = false

  const publicDirCall = (call: TS.CallExpression): void => {
    const [options, ...rest] = call.arguments
    const refuse = (why: string): void => {
      publicDirLeft = true
      manual.push({ line: lineOf(call), reason: `${why}: call ${PUBLIC_DIR_FORM}` })
    }
    if (staticName === undefined) {
      refuse("`serveStatic` already names something else here")
      return
    }
    if (options === undefined || rest.length > 0 || !ts.isObjectLiteralExpression(options)) {
      refuse("servePublicDir with options built elsewhere")
      return
    }
    const values = new Map<string, TS.Expression | undefined>()
    for (const property of options.properties) {
      const name =
        ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
          ? propertyName(ts, property.name)
          : undefined
      if (name === undefined || !PUBLIC_DIR_KEYS.has(name)) {
        refuse(`servePublicDir option \`${source(property)}\` has no direct counterpart`)
        return
      }
      values.set(name, ts.isPropertyAssignment(property) ? property.initializer : undefined)
    }
    if (!values.has("dir")) {
      refuse("servePublicDir without a `dir`")
      return
    }
    const field = (name: string, as = name): string => {
      const value = values.get(name)
      return value === undefined
        ? as === name
          ? name
          : `${as}: ${name}`
        : `${as}: ${source(value)}`
    }
    let cacheControl: string | undefined
    if (values.has("cache")) {
      const cache = values.get("cache")
      if (cache === undefined || !ts.isObjectLiteralExpression(cache)) {
        refuse("servePublicDir `cache` built elsewhere")
        return
      }
      for (const property of cache.properties) {
        const name = ts.isPropertyAssignment(property) ? propertyName(ts, property.name) : undefined
        if (name === "assets" && ts.isPropertyAssignment(property)) {
          cacheControl = source(property.initializer)
        } else if (
          name === "hashed" &&
          ts.isPropertyAssignment(property) &&
          ts.isStringLiteralLike(property.initializer) &&
          property.initializer.text === YEAR
        ) {
          // serveStatic's own cache-control for a content-hashed file.
        } else {
          refuse(
            `servePublicDir \`cache.${name ?? "?"}\` has no counterpart: a content-hashed file is always sent \`${YEAR}\``,
          )
          return
        }
      }
    }
    if (cacheControl === undefined) {
      if (coreDay) dayUsed = true
      cacheControl = coreDay ? "ONE_DAY" : `${quote}${DAY}${quote}`
    }
    const prefixValue = values.get("hashedPrefix")
    // A shorthand `hashedPrefix` is a binding of that name.
    const hashedPrefix = !values.has("hashedPrefix")
      ? `${quote}/assets/${quote}`
      : prefixValue === undefined
        ? "hashedPrefix"
        : source(prefixValue)
    const hashed = values.has("hashedFiles")
      ? field("hashedFiles")
      : `hashedFiles: (path) => path.startsWith(${hashedPrefix})`
    const fields = [
      field("dir"),
      `prefix: ${quote}/${quote}`,
      // A miss is the app's: servePublicDir answered `undefined` for every path it could not serve.
      "fallthrough: true",
      hashed,
      `cacheControl: ${cacheControl}`,
      ...(values.has("files") ? [field("files")] : []),
    ]
    const literal = source(options)
    let body: string
    if (literal.includes("\n")) {
      const first = options.properties[0]
      const lineStart = (at: number): number => text.lastIndexOf("\n", at - 1) + 1
      const indent =
        first === undefined
          ? "  "
          : text.slice(lineStart(first.getStart(tree)), first.getStart(tree))
      const close =
        text.slice(lineStart(options.getStart(tree)), options.getStart(tree)).match(/^\s*/)?.[0] ??
        ""
      body = `{\n${fields.map((f) => `${indent}${f},`).join("\n")}\n${close}}`
    } else body = `{ ${fields.join(", ")} }`
    edits.push({ start: call.getStart(tree), end: call.end, text: `${staticName}(${body})` })
    staticUsed = true
    count++
  }

  const serveCall = (call: TS.CallExpression, node: boolean): void => {
    const options = call.arguments[1]
    if (options === undefined) return
    if (!ts.isObjectLiteralExpression(options)) {
      if (/\bsignals\b/.test(text) || (node && /\bstatic\s*:/.test(text))) {
        manual.push({
          line: lineOf(options),
          reason: `serve() options built elsewhere: rename \`signals\` to \`gracefulSignals\`${node ? ", and pass `static` a function, serveStatic(mounts) for mount objects" : ""}`,
        })
      }
      return
    }
    for (const property of options.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (/\bsignals\b/.test(source(property.expression)) || /\bsignals\b/.test(text)) {
          manual.push({
            line: lineOf(property),
            reason:
              "serve() options spread in: rename `signals` to `gracefulSignals` where they are built",
          })
        }
        continue
      }
      const name = propertyName(ts, property.name)
      if (name === "signals") {
        if (ts.isShorthandPropertyAssignment(property)) {
          edits.push({
            start: property.getStart(tree),
            end: property.end,
            text: "gracefulSignals: signals",
          })
        } else {
          edits.push({
            start: property.name.getStart(tree),
            end: property.name.end,
            text: "gracefulSignals",
          })
        }
        count++
      } else if (node && name === "static" && ts.isPropertyAssignment(property)) {
        const value = property.initializer
        if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) {
          if (staticName === undefined) {
            manual.push({
              line: lineOf(value),
              reason:
                "`static` takes a function now: wrap the mounts in serveStatic(), which another binding here is named",
            })
            continue
          }
          edits.push({
            start: value.getStart(tree),
            end: value.end,
            text: `${staticName}(${source(value)})`,
          })
          staticUsed = true
          count++
        } else if (
          !ts.isCallExpression(value) &&
          !ts.isArrowFunction(value) &&
          !ts.isFunctionExpression(value)
        ) {
          manual.push({
            line: lineOf(value),
            reason:
              "`static` takes a function now: pass serveStatic(mounts) if this holds mount objects",
          })
        }
      }
    }
  }

  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      if (callee === publicDir) {
        publicDirCall(node)
        return
      }
      if (nodeServe.has(callee)) serveCall(node, true)
      else if (denoServe.has(callee)) serveCall(node, false)
    } else if (ts.isIdentifier(node) && node.text === "servePublicDir" && publicDir === undefined) {
      // Reached some way other than a static import (a dynamic one, a require): never left unsaid.
      if (!manual.some(({ line }) => line === lineOf(node))) {
        manual.push({
          line: lineOf(node),
          reason: `servePublicDir is removed from ${WEB}: use ${PUBLIC_DIR_FORM} from ${CORE_STATIC}`,
        })
      }
    } else if (
      ts.isIdentifier(node) &&
      node.text === publicDir &&
      !ts.isImportSpecifier(node.parent) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      publicDirLeft = true
      manual.push({
        line: lineOf(node),
        reason: `servePublicDir used as a value: use ${PUBLIC_DIR_FORM}`,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  const removed = new Set([...hashedFilesSpecifiers, ...(publicDirLeft ? [] : publicDirSpecifiers)])
  if (count === 0 && removed.size === 0) return { text, count: 0, manual }

  // The web import loses the removed names; the runtime's serveStatic (and ONE_DAY) are imported.
  const names: string[] = []
  if (staticUsed && existingStatic === undefined) names.push("serveStatic")
  if (dayUsed) names.push("ONE_DAY")
  if (hashedFilesLocal !== undefined) {
    names.push(
      hashedFilesLocal === "HashedFiles"
        ? "type HashedFiles"
        : `type HashedFiles as ${hashedFilesLocal}`,
    )
  }
  const target = imports.get(runtimeModule)
  let added: string | undefined
  if (names.length > 0) {
    if (target?.named !== undefined) {
      const all = [...target.named.elements.map(source), ...names].toSorted(specifierOrder)
      edits.push({
        start: target.named.getStart(tree),
        end: target.named.end,
        text: `{ ${all.join(", ")} }`,
      })
    } else {
      added = `import { ${names.toSorted(specifierOrder).join(", ")} } from ${importQuote}${runtimeModule}${importQuote}`
    }
  }
  // The new import goes where the first web import that loses a name was, or after the imports.
  let placed = added === undefined
  for (const { declaration, named } of webImports) {
    if (!named.elements.some((element) => removed.has(element))) continue
    const kept = named.elements.filter((element) => !removed.has(element)).map(source)
    const place = placed ? undefined : added
    placed = true
    if (kept.length === 0 && declaration.importClause?.name === undefined) {
      // The declaration goes, with its line ending, unless the new import takes its place.
      const eol = text.startsWith("\r\n", declaration.end)
        ? 2
        : text[declaration.end] === "\n"
          ? 1
          : 0
      edits.push({
        start: declaration.getStart(tree),
        end: place === undefined ? declaration.end + eol : declaration.end,
        text: place ?? "",
      })
    } else {
      edits.push({ start: named.getStart(tree), end: named.end, text: `{ ${kept.join(", ")} }` })
      if (place !== undefined)
        edits.push({ start: declaration.end, end: declaration.end, text: `\n${place}` })
    }
  }
  if (!placed && added !== undefined) {
    const last = tree.statements.filter(ts.isImportDeclaration).at(-1)
    const at = last?.end ?? 0
    edits.push({ start: at, end: at, text: last === undefined ? `${added}\n` : `\n${added}` })
  }
  return { text: applyEdits(text, edits), count, manual }
}

const WEB_APP = "createWebApp"

/** `createWebApp({ experimental: { ppr } })` becomes `createWebApp({ ppr })`: 5.10 moved the option. */
function rewritePprOption(ts: typeof TS, file: string, text: string): RewriteResult {
  const { tree, lineOf } = parseSource(ts, file, text)
  const edits: Edit[] = []
  const manual: ManualSite[] = []
  let count = 0
  // The names createWebApp is imported under, and the names @nifrajs/web is imported as a namespace.
  const locals = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    if (statement.moduleSpecifier.text !== WEB) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    else {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === WEB_APP) locals.add(element.name.text)
      }
    }
  }
  const isCreateWebApp = (callee: TS.Expression): boolean =>
    (ts.isIdentifier(callee) && locals.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text) &&
      callee.name.text === WEB_APP)
  const nameOf = (property: TS.ObjectLiteralElementLike): string | undefined =>
    ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : ts.isPropertyAssignment(property)
        ? propertyName(ts, property.name)
        : undefined
  const property = (
    object: TS.ObjectLiteralExpression,
    name: string,
  ): TS.ObjectLiteralElementLike | undefined => object.properties.find((p) => nameOf(p) === name)
  const handled = new Set<TS.ObjectLiteralExpression>()

  const move = (options: TS.ObjectLiteralExpression): void => {
    const experimental = property(options, "experimental")
    if (experimental === undefined) return
    const spread = options.properties.some((p) => ts.isSpreadAssignment(p))
    const inner = ts.isPropertyAssignment(experimental) ? experimental.initializer : undefined
    const moved = inner !== undefined && ts.isObjectLiteralExpression(inner) ? inner : undefined
    const only = moved?.properties.length === 1 ? moved.properties[0] : undefined
    if (
      moved === undefined ||
      only === undefined ||
      nameOf(only) !== "ppr" ||
      property(options, "ppr") !== undefined ||
      spread
    ) {
      manual.push({
        line: lineOf(experimental),
        reason:
          "experimental.ppr is now ppr: pass it beside the other createWebApp options and remove `experimental`",
      })
      return
    }
    edits.push({
      start: experimental.getStart(tree),
      end: experimental.end,
      text: ts.isPropertyAssignment(only) ? `ppr: ${only.initializer.getText(tree)}` : "ppr",
    })
    count++
  }

  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node) && isCreateWebApp(node.expression)) {
      const options = node.arguments[0]
      if (options !== undefined && ts.isObjectLiteralExpression(options)) {
        handled.add(options)
        move(options)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)

  // Options built apart from the call, or passed through a name, are the user's to move.
  const sweep = (node: TS.Node): void => {
    if (ts.isObjectLiteralExpression(node) && !handled.has(node)) {
      const experimental = property(node, "experimental")
      const inner =
        experimental !== undefined && ts.isPropertyAssignment(experimental)
          ? experimental.initializer
          : undefined
      if (
        inner !== undefined &&
        ts.isObjectLiteralExpression(inner) &&
        property(inner, "ppr") !== undefined
      ) {
        manual.push({
          line: lineOf(node),
          reason:
            "experimental.ppr is now ppr: pass it beside the other createWebApp options and remove `experimental`",
        })
      }
    }
    ts.forEachChild(node, sweep)
  }
  sweep(tree)
  return {
    text: applyEdits(text, edits),
    count,
    manual: manual.toSorted((a, b) => a.line - b.line),
  }
}

const HREF_RAW = "rawHref"
// Where `redirect`, `useNavigate` and React's `Link` come from; each also exports `rawHref`.
const HREF_PROVIDER = /^@nifrajs\/web(?:-(?:react|preact|vue|svelte|solid)\/router)?$/
const LINK_PROVIDER = "@nifrajs/web-react/router"
const LINK_TAGS = ["Link", "NavLink", "Navigate"]
const STRING_BUILT =
  "the destination is built from a string: build it with href({ to, params, search }), or wrap a path built elsewhere in rawHref(path)"

/**
 * 5.10: `navigate()`, `redirect()` and React's `Link`, `NavLink` and `Navigate` take an `Href`. A
 * string path written whole at one of those sites becomes `rawHref(path)`, which sends the same
 * request the string did. A destination built from a template or a concatenation, an object passed to
 * `navigate`, and a path `rawHref` refuses are listed, since each needs a route and its params.
 */
function rewriteHrefNavigation(ts: typeof TS, file: string, text: string): RewriteResult {
  const { tree } = parseSource(ts, file, text)
  const source = (node: TS.Node): string => node.getText(tree)
  const bound = new Map<
    string,
    { readonly exported: string; readonly from: string; readonly named: TS.NamedImports }
  >()
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const from = statement.moduleSpecifier.text
    const clause = statement.importClause
    const bindings = clause?.namedBindings
    if (!HREF_PROVIDER.test(from) || clause?.isTypeOnly === true) continue
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue
      bound.set(element.name.text, {
        exported: (element.propertyName ?? element.name).text,
        from,
        named: bindings,
      })
    }
  }
  const localsOf = (exported: string | readonly string[], from?: string): Set<string> =>
    new Set(
      [...bound]
        .filter(
          ([, entry]) =>
            (typeof exported === "string"
              ? entry.exported === exported
              : exported.includes(entry.exported)) &&
            (from === undefined || entry.from === from),
        )
        .map(([local]) => local),
    )
  const redirects = localsOf("redirect", "@nifrajs/web")
  const useNavigates = localsOf("useNavigate")
  const tags = localsOf(LINK_TAGS, LINK_PROVIDER)
  if (redirects.size + useNavigates.size + tags.size === 0) return { text, count: 0, manual: [] }
  const rawLocal = [...bound].find(([, entry]) => entry.exported === HREF_RAW)?.[0]
  const importQuote = /from\s*'/.test(text) ? "'" : '"'
  const quote = quoteOf(ts, tree, importQuote)

  const navigates = new Set<string>()
  const collect = (node: TS.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      useNavigates.has(node.initializer.expression.text)
    ) {
      navigates.add(node.name.text)
    }
    ts.forEachChild(node, collect)
  }
  collect(tree)

  const edits: Edit[] = []
  const manualAt: { readonly pos: number; readonly reason: string }[] = []
  // The import of the first name a rewritten site uses; `rawHref` is added to it.
  let host: TS.NamedImports | undefined
  let count = 0
  const raw = rawLocal ?? HREF_RAW
  // A `rawHref` of the file's own would be called in place of the export.
  const taken = rawLocal === undefined && /\brawHref\b/.test(text)

  const isStringy = (node: TS.Expression): boolean =>
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (isStringy(node.left) || isStringy(node.right)))
  const list = (node: TS.Node, reason: string): void => {
    manualAt.push({ pos: node.getStart(tree), reason })
  }
  // Rewrites one destination; `owner` names the import that brought the API in, and `attribute` is a
  // JSX attribute's own string, which gains the braces of an expression.
  const destination = (node: TS.Expression, owner: string, attribute = false): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isSameOriginPath(node.text)) {
        list(
          node,
          `${JSON.stringify(node.text)} is not a same-origin path, which an Href must be: another site is a plain <a href>, or redirect(url, { external: true })`,
        )
      } else if (taken) {
        list(node, `${HREF_RAW} is already a name in this file: import it under another name`)
      } else {
        const written =
          attribute && ts.isStringLiteral(node) ? jsxAttributeValue(node) : source(node)
        if (written === undefined) {
          list(node, "wrap the path in rawHref(path), written as a JavaScript string")
          return
        }
        edits.push({
          start: node.getStart(tree),
          end: node.end,
          text: attribute ? `{${raw}(${written})}` : `${raw}(${written})`,
        })
        host ??= bound.get(owner)?.named
        count++
      }
    } else if (isStringy(node)) list(node, STRING_BUILT)
  }
  // A JSX attribute string is not JavaScript: entities and escapes read differently.
  const jsxAttributeValue = (node: TS.StringLiteral): string | undefined => {
    const value = node.text
    if (/[\\&\n]/.test(value) || value.includes(quote)) return undefined
    return `${quote}${value}${quote}`
  }

  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      const first = node.arguments[0]
      const options = node.arguments[1]
      const isRedirect = redirects.has(callee)
      if (first !== undefined && (isRedirect || navigates.has(callee))) {
        const external =
          isRedirect &&
          options !== undefined &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (p) => p.name !== undefined && propertyName(ts, p.name) === "external",
          )
        if (!external) {
          if (ts.isObjectLiteralExpression(first)) {
            list(
              first,
              "navigate({ to, search, replace }) is navigate(href({ to, search }), { replace }): the route and its params are the app's to name",
            )
          } else {
            const owner = isRedirect
              ? callee
              : ([...bound].find(([, entry]) => entry.exported === "useNavigate")?.[0] ?? callee)
            destination(first, owner)
          }
        }
      }
    } else if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      tags.has(node.tagName.text)
    ) {
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || attribute.name.getText(tree) !== "to") continue
        const value = attribute.initializer
        if (value === undefined) continue
        if (ts.isStringLiteral(value)) destination(value, node.tagName.text, true)
        else if (ts.isJsxExpression(value) && value.expression !== undefined)
          destination(value.expression, node.tagName.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)

  if (host !== undefined && rawLocal === undefined) {
    const all = [...host.elements.map(source), HREF_RAW].toSorted(specifierOrder)
    const multiline = source(host).includes("\n")
    const first = host.elements[0]
    const indent =
      first === undefined
        ? "  "
        : text.slice(text.lastIndexOf("\n", first.getStart(tree)) + 1, first.getStart(tree))
    const close = text.slice(text.lastIndexOf("\n", host.end - 1) + 1, host.end - 1)
    edits.push({
      start: host.getStart(tree),
      end: host.end,
      text: multiline
        ? `{\n${all.map((name) => `${indent}${name},`).join("\n")}\n${close}}`
        : `{ ${all.join(", ")} }`,
    })
  }
  const next = applyEdits(text, edits)
  // The line a site has in the rewritten file, which is the one a reader opens.
  const lineAfter = (pos: number): number => {
    let at = pos
    for (const edit of edits) if (edit.end <= pos) at += edit.text.length - (edit.end - edit.start)
    return next.slice(0, at).split("\n").length
  }
  return {
    text: next,
    count,
    manual: manualAt
      .map(({ pos, reason }) => ({ line: lineAfter(pos), reason }))
      .toSorted((a, b) => a.line - b.line),
  }
}

const HREF_NAVIGATION: SourceRewrite = {
  id: "href-navigation",
  description:
    "string paths given to navigate(), redirect() and React's Link, NavLink and Navigate → rawHref(path)",
  mentions: (text) =>
    /@nifrajs\/web/.test(text) && /\b(?:redirect|useNavigate|Link|NavLink|Navigate)\b/.test(text),
  rewrite: rewriteHrefNavigation,
}

const PPR_OPTION: SourceRewrite = {
  id: "ppr-option",
  description: "createWebApp({ experimental: { ppr } }) → createWebApp({ ppr })",
  mentions: (text) => /\bexperimental\b/.test(text) && /\bcreateWebApp\b/.test(text),
  rewrite: rewritePprOption,
}

const SERVE_STATIC: SourceRewrite = {
  id: "serve-static",
  description:
    "servePublicDir → serveStatic, @nifrajs/node `static` mounts → serveStatic(), `signals` → `gracefulSignals`",
  mentions: (text) =>
    text.includes("servePublicDir") ||
    (/@nifrajs\/(?:node|deno)["']/.test(text) && /\bsignals\b|\bstatic\s*:/.test(text)),
  rewrite: rewriteServeStatic,
}

const REWRITES: Readonly<Record<string, SourceRewrite>> = {
  [SERVE_STATIC.id]: SERVE_STATIC,
  [PPR_OPTION.id]: PPR_OPTION,
  [HREF_NAVIGATION.id]: HREF_NAVIGATION,
}

export function getSourceRewrite(id: string): SourceRewrite | undefined {
  return REWRITES[id]
}
