/**
 * NF-C039: contract operations the source implements but `backend/app.ts` does not serve. The contract
 * lock, the typed client checks and `nifra routes` read the backend that file exports, so an
 * `implement(contract, handlers)` app built anywhere else is invisible to every one of them.
 *
 * The served routes come from the backend the contract-lock check already loaded; this rule runs no
 * project code of its own. Without a lock the backend is not loaded and the comparison is skipped.
 * A contract imported from a workspace package is read through that package's `exports`.
 * Re-exports on the way to a contract, and `...operations` spreads inside one, are followed.
 */
import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import type * as TSApi from "typescript"
import { BACKEND_APP_FILE } from "../app-files.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { createSpecifierResolver, type SpecifierResolver } from "../internal/project-specifiers.ts"
import { realpathOrSelf } from "../internal/realpath-or-self.ts"
import { scriptKindOf } from "../internal/script-kind.ts"
import { createExportedFileResolver } from "../internal/workspace-packages.ts"
import type { CheckRule } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

const CONTRACT_MODULE = "@nifrajs/core/contract"
const CODE_FILE = /\.[cm]?[jt]sx?$/
// `export { implement } from "@nifrajs/core/contract"` or `export * from ...`: a project module that
// passes the contract API through.
const PASSES_THROUGH = (name: string): RegExp =>
  new RegExp(
    `export\\s*(?:\\*|\\{[^}]*\\b${name}\\b[^}]*\\})\\s*from\\s*["']${CONTRACT_MODULE}["']`,
  )
const LISTED = 6

interface Operation {
  readonly name: string
  readonly method: string
  readonly path: string
}

interface Implementation {
  readonly file: string
  readonly line: number
  readonly contract: string
  readonly operations: readonly Operation[]
  /** Why some operations could not be read, when any could not. */
  readonly unreadable: readonly string[]
}

/** The contract API names a file binds: local name -> `implement` or `defineContract`. */
interface Bindings {
  readonly named: ReadonlyMap<string, "implement" | "defineContract">
  /** Namespace imports of the contract module: `c` in `c.implement(...)`. */
  readonly namespaces: ReadonlySet<string>
  /** Local name -> the specifier and imported name, for an import from a project module. */
  readonly imported: ReadonlyMap<string, { readonly specifier: string; readonly name: string }>
}

function unwrap(ts: typeof TSApi, node: TSApi.Expression): TSApi.Expression {
  let current = node
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  )
    current = current.expression
  return current
}

function bindings(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
  file: string,
  root: string,
  resolve: SpecifierResolver,
): Bindings {
  const named = new Map<string, "implement" | "defineContract">()
  const namespaces = new Set<string>()
  const imported = new Map<string, { specifier: string; name: string }>()
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const specifier = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (clause === undefined || clause.isTypeOnly) continue
    const bound = clause.namedBindings
    if (bound !== undefined && ts.isNamespaceImport(bound)) {
      if (specifier === CONTRACT_MODULE) namespaces.add(bound.name.text)
      continue
    }
    if (bound === undefined) continue
    // A project module may pass the API through; one hop is followed.
    let passesThrough: ((name: string) => boolean) | undefined
    if (specifier !== CONTRACT_MODULE) {
      const target = resolve(join(root, file), specifier)
      const text = target === undefined ? undefined : readText(target)
      passesThrough =
        text === undefined ? () => false : (name: string) => PASSES_THROUGH(name).test(text)
    }
    for (const element of bound.elements) {
      if (element.isTypeOnly) continue
      const name = (element.propertyName ?? element.name).text
      if (name === "implement" || name === "defineContract") {
        if (passesThrough === undefined || passesThrough(name)) named.set(element.name.text, name)
      } else if (passesThrough !== undefined) imported.set(element.name.text, { specifier, name })
    }
  }
  return { named, namespaces, imported }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/** Whether `callee` names the contract API's `api` function under these bindings. */
function calls(
  ts: typeof TSApi,
  callee: TSApi.Expression,
  bound: Bindings,
  api: "implement" | "defineContract",
): boolean {
  if (ts.isIdentifier(callee)) return bound.named.get(callee.text) === api
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    bound.namespaces.has(callee.expression.text) &&
    callee.name.text === api
  )
}

interface OperationsRead {
  readonly operations: readonly Operation[]
  readonly unreadable: readonly string[]
}

/** The operations an object literal of a contract declares, and what could not be read. `spreadOf`
 * reads a `...name` spread of another operations object. */
function operationsOf(
  ts: typeof TSApi,
  literal: TSApi.ObjectLiteralExpression,
  spreadOf: (name: string) => OperationsRead | undefined,
): OperationsRead {
  // A later key replaces an earlier one, as in the object the page builds at runtime.
  const operations = new Map<string, Operation>()
  const unreadable: string[] = []
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = unwrap(ts, property.expression)
      const read = ts.isIdentifier(spread) ? spreadOf(spread.text) : undefined
      if (read !== undefined) {
        for (const op of read.operations) operations.set(op.name, op)
        unreadable.push(...read.unreadable)
        continue
      }
    }
    if (!ts.isPropertyAssignment(property)) {
      unreadable.push("an operation spread or written as a method")
      continue
    }
    const name = property.name.getText().replace(/^["']|["']$/g, "")
    const op = unwrap(ts, property.initializer)
    if (!ts.isObjectLiteralExpression(op)) {
      unreadable.push(`operation "${name}" is not an object literal`)
      continue
    }
    const field = (key: string): string | undefined => {
      for (const member of op.properties) {
        if (!ts.isPropertyAssignment(member) || member.name.getText() !== key) continue
        const value = unwrap(ts, member.initializer)
        return ts.isStringLiteralLike(value) ? value.text : undefined
      }
      return undefined
    }
    const method = field("method")
    const path = field("path")
    if (method === undefined || path === undefined)
      unreadable.push(`operation "${name}" has a method or path that is not a string literal`)
    else operations.set(name, { name, method: method.toUpperCase(), path })
  }
  return { operations: [...operations.values()], unreadable }
}

interface Parsed {
  readonly tree: TSApi.SourceFile
  readonly bound: Bindings
}

/** An operations object literal and the file it is written in, which its spreads resolve against. */
interface Located {
  readonly literal: TSApi.ObjectLiteralExpression
  readonly file: string
  readonly parsed: Parsed
}

export const contractVisibilityRule: CheckRule = {
  code: "NF-C039",
  title: "Implemented contract operation the backend does not serve",
  async scan(ctx) {
    // The backend compared against is this package's, so a file in a nested package is not read.
    const ownPackage = new Map<string, boolean>()
    const inOwnPackage = (dir: string): boolean => {
      if (dir === "") return true
      const cached = ownPackage.get(dir)
      if (cached !== undefined) return cached
      const own =
        !existsSync(join(ctx.root, dir, "package.json")) &&
        inOwnPackage(dir.slice(0, Math.max(dir.lastIndexOf("/"), 0)))
      ownPackage.set(dir, own)
      return own
    }
    const candidates = ctx.sources.files.filter((file) => {
      if (!CODE_FILE.test(file) || file.endsWith(".d.ts")) return false
      if (!inOwnPackage(file.slice(0, Math.max(file.lastIndexOf("/"), 0)))) return false
      const text = ctx.sources.read(file)
      return text?.includes("implement") === true
    })
    if (candidates.length === 0) return []
    const loaded = await loadRuleTypeScript(ctx)
    const ts = loaded.compiler
    if (ts === undefined) return []
    const projectResolve = createSpecifierResolver()
    const packageEntry = await createExportedFileResolver(ctx.root)
    /** Why a package specifier could not be read, by importing file and specifier. */
    const packageReasons = new Map<string, string>()
    const resolve: SpecifierResolver = (from, specifier) => {
      const local = projectResolve(from, specifier)
      if (local !== undefined) return local
      const entry = packageEntry(from, specifier)
      if (entry === undefined) return undefined
      if ("path" in entry) return entry.path
      packageReasons.set(`${from}\0${specifier}`, entry.reason)
      return undefined
    }
    // The resolver answers with real paths, so the root is read as one to name files project-relative.
    const realRoot = realpathOrSelf(ctx.root)
    const parsedCache = new Map<string, Parsed | undefined>()
    /** A project file, by its project-relative name, parsed with its contract bindings. */
    const parse = (file: string, text: string | undefined): Parsed | undefined => {
      if (parsedCache.has(file)) return parsedCache.get(file)
      const tree =
        text === undefined
          ? undefined
          : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(ts, file))
      const parsed =
        tree === undefined
          ? undefined
          : { tree, bound: bindings(ts, tree, file, ctx.root, resolve) }
      parsedCache.set(file, parsed)
      return parsed
    }
    /** The object literal `defineContract({...})` gives the const `name` in `file`, followed one hop
     * into a project module it is imported from, and through any re-exports on the way. */
    const contractLiteral = (
      file: string,
      parsed: Parsed,
      name: string,
      hops = 0,
      seen = new Set<string>(),
    ): Located | undefined => {
      for (const statement of parsed.tree.statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
          if (declaration.initializer === undefined) return undefined
          const init = unwrap(ts, declaration.initializer)
          if (ts.isObjectLiteralExpression(init)) return { literal: init, file, parsed }
          if (
            !ts.isCallExpression(init) ||
            !calls(ts, init.expression, parsed.bound, "defineContract")
          )
            return undefined
          const arg = init.arguments[0]
          const literal = arg === undefined ? undefined : unwrap(ts, arg)
          return literal !== undefined && ts.isObjectLiteralExpression(literal)
            ? { literal, file, parsed }
            : undefined
        }
      }
      const from = parsed.bound.imported.get(name)
      if (from !== undefined)
        return hops > 0 ? undefined : follow(file, from.specifier, from.name, hops + 1, seen)
      // A re-export declares nothing, so passing through one does not spend the hop.
      for (const statement of parsed.tree.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          statement.isTypeOnly ||
          statement.moduleSpecifier === undefined ||
          !ts.isStringLiteral(statement.moduleSpecifier)
        )
          continue
        const clause = statement.exportClause
        if (clause === undefined) {
          const found = follow(file, statement.moduleSpecifier.text, name, hops, seen)
          if (found !== undefined) return found
          continue
        }
        if (!ts.isNamedExports(clause)) continue
        const element = clause.elements.find((e) => !e.isTypeOnly && e.name.text === name)
        if (element !== undefined)
          return follow(
            file,
            statement.moduleSpecifier.text,
            (element.propertyName ?? element.name).text,
            hops,
            seen,
          )
      }
      return undefined
    }
    const follow = (
      file: string,
      specifier: string,
      name: string,
      hops: number,
      seen: Set<string>,
    ): Located | undefined => {
      const target = resolve(join(ctx.root, file), specifier)
      if (target === undefined) return undefined
      const rel = relative(realRoot, target).replaceAll("\\", "/")
      const key = `${rel}\0${name}`
      if (seen.has(key)) return undefined
      seen.add(key)
      const next = parse(rel, readText(target))
      return next === undefined ? undefined : contractLiteral(rel, next, name, hops, seen)
    }

    // Each spread is looked up afresh from the file it is written in; the depth only stops a cycle.
    const readOperations = (found: Located, depth = 0): OperationsRead =>
      operationsOf(ts, found.literal, (name) => {
        if (depth >= 8) return undefined
        const inner = contractLiteral(found.file, found.parsed, name)
        return inner === undefined ? undefined : readOperations(inner, depth + 1)
      })

    const implementations: Implementation[] = []
    for (const file of candidates) {
      const parsed = parse(file, ctx.sources.read(file))
      if (
        parsed === undefined ||
        (parsed.bound.named.size === 0 && parsed.bound.namespaces.size === 0)
      )
        continue
      const visit = (node: TSApi.Node): void => {
        if (ts.isCallExpression(node) && calls(ts, node.expression, parsed.bound, "implement")) {
          const line = parsed.tree.getLineAndCharacterOfPosition(node.getStart()).line + 1
          const arg = node.arguments[0] === undefined ? undefined : unwrap(ts, node.arguments[0])
          let located: Located | undefined
          let contract = arg?.getText() ?? "(none)"
          if (arg !== undefined && ts.isIdentifier(arg))
            located = contractLiteral(file, parsed, arg.text)
          else if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
            located = { literal: arg, file, parsed }
            contract = "an inline contract"
          } else if (
            arg !== undefined &&
            ts.isCallExpression(arg) &&
            calls(ts, arg.expression, parsed.bound, "defineContract")
          ) {
            const inner = arg.arguments[0] === undefined ? undefined : unwrap(ts, arg.arguments[0])
            if (inner !== undefined && ts.isObjectLiteralExpression(inner))
              located = { literal: inner, file, parsed }
            contract = "an inline contract"
          }
          if (located === undefined) {
            const from =
              arg !== undefined && ts.isIdentifier(arg)
                ? parsed.bound.imported.get(arg.text)?.specifier
                : undefined
            const reason =
              from === undefined
                ? undefined
                : packageReasons.get(`${join(ctx.root, file)}\0${from}`)
            implementations.push({
              file,
              line,
              contract,
              operations: [],
              unreadable: [
                reason === undefined
                  ? `the contract ${contract} is not a defineContract({...}) the scan can read`
                  : `the contract ${contract} is imported from "${from}", which the scan cannot read: ${reason}`,
              ],
            })
          } else implementations.push({ file, line, contract, ...readOperations(located) })
        }
        ts.forEachChild(node, visit)
      }
      visit(parsed.tree)
    }
    if (implementations.length === 0) return []

    const findings: Diagnostic[] = []
    for (const { file, line, contract, unreadable } of implementations) {
      if (unreadable.length === 0) continue
      findings.push(
        diagnostic({
          code: "NF-C039",
          severity: "warn",
          file,
          line,
          message: `implement(${contract}): the static scan cannot read every operation (${unreadable.join("; ")}), so NF-C039 cannot tell whether backend/app.ts serves them. Write each operation's method and path as string literals in a defineContract({...}) const`,
          verify: "nifra check --lints-only",
        }),
      )
    }

    if (!existsSync(join(ctx.root, BACKEND_APP_FILE))) {
      const count = implementations.reduce((sum, item) => sum + item.operations.length, 0)
      const first = implementations[0]
      if (count > 0 && first !== undefined) {
        findings.push(
          diagnostic({
            code: "NF-C039",
            severity: "warn",
            file: first.file,
            line: first.line,
            message: `${count} contract operation(s) are implemented in source, but there is no ${BACKEND_APP_FILE}, so the contract lock, the typed client checks and nifra routes see none of them. Export the implementing app from ${BACKEND_APP_FILE} as \`backend\`, built with stub dependencies if it needs any`,
            verify: "nifra check --lints-only",
          }),
        )
      }
      return findings
    }

    const served = ctx.project.check.contracts.served
    if (served === undefined) return findings
    const routes = served.map((key) => {
      const at = key.indexOf(" ")
      return { method: key.slice(0, at), path: key.slice(at + 1) }
    })
    const servedKeys = new Set(served)
    const servedAt = (prefix: string, op: Operation): boolean =>
      op.path === "/"
        ? servedKeys.has(`${op.method} ${prefix === "" ? "/" : prefix}`) ||
          servedKeys.has(`${op.method} ${prefix}/`)
        : servedKeys.has(`${op.method} ${prefix}${op.path}`)
    // A mount or group prefix serves every operation of the app under it, so one prefix must serve
    // them all. Matching each operation on its own lets `/` match any route and `/:id` any `.../:id`.
    const unserved = (operations: readonly Operation[]): readonly Operation[] => {
      const prefixes = new Set([""])
      for (const op of operations) {
        for (const route of routes) {
          if (route.method !== op.method) continue
          if (op.path === "/") prefixes.add(route.path.replace(/\/$/, ""))
          else if (route.path.endsWith(op.path)) prefixes.add(route.path.slice(0, -op.path.length))
        }
      }
      let fewest = operations
      for (const prefix of prefixes) {
        const missing = operations.filter((op) => !servedAt(prefix, op))
        if (missing.length < fewest.length) fewest = missing
      }
      return fewest
    }
    for (const { file, line, contract, operations } of implementations) {
      const missing = unserved(operations)
      if (missing.length === 0) continue
      const listed = missing.slice(0, LISTED).map((op) => `${op.method} ${op.path}`)
      const more = missing.length > LISTED ? ` and ${missing.length - LISTED} more` : ""
      findings.push(
        diagnostic({
          code: "NF-C039",
          severity: "warn",
          file,
          line,
          message: `implement(${contract}) serves ${missing.length} operation(s) that ${BACKEND_APP_FILE} does not: ${listed.join(", ")}${more}. The contract lock, the typed client checks and nifra routes read only the backend that file exports, so they cannot see these. Mount this app in ${BACKEND_APP_FILE}, built with stub dependencies if it needs any`,
          evidence: missing.map((op) => `${op.name}: ${op.method} ${op.path}`),
          verify: "nifra check",
        }),
      )
    }
    return findings
  },
}
