/**
 * Source rewrites an upgrade recipe names: the edits an import move cannot express, made on the
 * syntax tree with the project's own TypeScript. A rewrite changes only a shape it recognizes whole
 * and lists every other site for the user to edit by hand; it never guesses.
 */
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
const DAY = '"public, max-age=86400"'
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
function rewriteServeStatic(ts: typeof TS, file: string, text: string): RewriteResult {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(ts, file))
  const edits: Edit[] = []
  const manual: ManualSite[] = []
  let count = 0
  const lineOf = (node: TS.Node): number =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
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
    if (staticName === undefined) return refuse("`serveStatic` already names something else here")
    if (options === undefined || rest.length > 0 || !ts.isObjectLiteralExpression(options)) {
      return refuse("servePublicDir with options built elsewhere")
    }
    const values = new Map<string, TS.Expression | undefined>()
    for (const property of options.properties) {
      const name =
        ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
          ? propertyName(ts, property.name)
          : undefined
      if (name === undefined || !PUBLIC_DIR_KEYS.has(name)) {
        return refuse(`servePublicDir option \`${source(property)}\` has no direct counterpart`)
      }
      values.set(name, ts.isPropertyAssignment(property) ? property.initializer : undefined)
    }
    if (!values.has("dir")) return refuse("servePublicDir without a `dir`")
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
        return refuse("servePublicDir `cache` built elsewhere")
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
          return refuse(
            `servePublicDir \`cache.${name ?? "?"}\` has no counterpart: a content-hashed file is always sent \`${YEAR}\``,
          )
        }
      }
    }
    if (cacheControl === undefined) {
      if (coreDay) dayUsed = true
      cacheControl = coreDay ? "ONE_DAY" : DAY
    }
    const hashed = values.has("hashedFiles")
      ? field("hashedFiles")
      : `hashedFiles: (path) => path.startsWith(${values.has("hashedPrefix") ? source(values.get("hashedPrefix") as TS.Expression) : '"/assets/"'})`
    const fields = [
      field("dir"),
      'prefix: "/"',
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
  const quote = /from\s*'/.test(text) ? "'" : '"'
  const specifierOrder = (a: string, b: string): number =>
    codeUnitOrder(a.replace(/^type /, ""), b.replace(/^type /, ""))
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
      added = `import { ${names.toSorted(specifierOrder).join(", ")} } from ${quote}${runtimeModule}${quote}`
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

const SERVE_STATIC: SourceRewrite = {
  id: "serve-static",
  description:
    "servePublicDir → serveStatic, @nifrajs/node `static` mounts → serveStatic(), `signals` → `gracefulSignals`",
  mentions: (text) =>
    text.includes("servePublicDir") ||
    (/@nifrajs\/(?:node|deno)["']/.test(text) && /\bsignals\b|\bstatic\s*:/.test(text)),
  rewrite: rewriteServeStatic,
}

const REWRITES: Readonly<Record<string, SourceRewrite>> = { [SERVE_STATIC.id]: SERVE_STATIC }

export function getSourceRewrite(id: string): SourceRewrite | undefined {
  return REWRITES[id]
}
