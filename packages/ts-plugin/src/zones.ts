/**
 * Zone diagnostics: the frontend/backend import rules of `@nifrajs/web/zones`, in the editor.
 *
 * Assist only. The browser builds, the dev servers and `nifra check` enforce the same rules with the
 * full import chain; this reports the direct edge as it is typed, so a backend import in a page is
 * red before anything is built. Files in no zone (tests, scripts, config) are never reported: no
 * build loads them.
 */
import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import {
  BACKEND_ONLY_MARKER,
  browserDenial,
  type Classification,
  createZoneClassifier,
  importAllowed,
  importRuleMessage,
  specifierPackage,
  type Zone,
  type ZoneClassifier,
} from "@nifrajs/web/zones"
import type * as ts from "typescript"

/** The code every zone diagnostic carries; TypeScript requires a number, and none of its own is this. */
export const ZONE_DIAGNOSTIC_CODE = 990028

/** Zones whose own code runs in a browser. */
const BROWSER_CODE: ReadonlySet<Zone> = new Set(["route-frontend", "frontend", "shared"])

interface ImportEdge {
  readonly specifier: string
  readonly literal: ts.StringLiteralLike
}

const allTypes = (elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): boolean =>
  elements.length > 0 && elements.every((element) => element.isTypeOnly)

/** Every value import in a file: static, re-export and literal dynamic `import()`. Type-only ones are
 * erased before bundling, so they may cross zones. */
function valueImports(tsm: typeof ts, source: ts.SourceFile): ImportEdge[] {
  const edges: ImportEdge[] = []
  const add = (node: ts.Expression | undefined): void => {
    if (node !== undefined && tsm.isStringLiteralLike(node)) {
      edges.push({ specifier: node.text, literal: node })
    }
  }
  const visit = (node: ts.Node): void => {
    if (tsm.isImportDeclaration(node)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            bindings !== undefined &&
            tsm.isNamedImports(bindings) &&
            allTypes(bindings.elements)))
      if (!typeOnly) add(node.moduleSpecifier)
      return
    }
    if (tsm.isExportDeclaration(node)) {
      const clause = node.exportClause
      const typeOnly =
        node.isTypeOnly ||
        (clause !== undefined && tsm.isNamedExports(clause) && allTypes(clause.elements))
      if (!typeOnly) add(node.moduleSpecifier)
      return
    }
    if (
      tsm.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      tsm.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression)
      return
    }
    if (tsm.isCallExpression(node) && node.expression.kind === tsm.SyntaxKind.ImportKeyword) {
      add(node.arguments[0])
    }
    tsm.forEachChild(node, visit)
  }
  visit(source)
  return edges
}

/** Where an import lands: TypeScript's resolution (tsconfig `paths` included), else a relative path
 * that exists on disk (an `.svelte` or `.vue` file TypeScript only knows through a shim). */
function resolveImport(
  tsm: typeof ts,
  source: ts.SourceFile,
  edge: ImportEdge,
  options: ts.CompilerOptions,
): string | undefined {
  const specifier = edge.specifier.replace(/[?#].*$/, "")
  const mode = tsm.getModeForUsageLocation(source, edge.literal, options)
  const resolved = tsm.resolveModuleName(
    specifier,
    source.fileName,
    options,
    tsm.sys,
    undefined,
    undefined,
    mode,
  ).resolvedModule?.resolvedFileName
  if (resolved !== undefined) return resolved
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined
  const file = resolve(dirname(source.fileName), specifier)
  return existsSync(file) ? file : undefined
}

const real = (file: string): string => {
  try {
    return realpathSync.native(file)
  } catch {
    return file
  }
}

/** A third-party target as the specifier names it: TypeScript resolves `pg` to `@types/pg`, and the
 * server-package list knows `pg`. */
function libraryAsImported(target: Classification, specifier: string): Classification {
  if (target.zone !== "library") return target
  const named = specifierPackage(specifier)
  if (named === undefined || named === target.packageName) return target
  return { zone: "library", packageName: named }
}

/** Why one import breaks the zone rules, or `undefined` when it does not. */
function edgeProblem(
  classifier: ZoneClassifier,
  display: (file: string) => string,
  fileName: string,
  from: Zone,
  specifier: string,
  target: string | undefined,
): string | undefined {
  const browser = BROWSER_CODE.has(from)
  if (browser && /^(?:node|bun):/.test(specifier)) {
    return `"${specifier}" may not reach the browser: Node and Bun built-ins run on the server only; use them in a route's backend half or under backend/`
  }
  if (browser && specifier === BACKEND_ONLY_MARKER) {
    return `"${BACKEND_ONLY_MARKER}" marks a module backend-only, but ${display(fileName)} reaches the browser. Move it under backend/ or into a route's backend half`
  }
  if (target === undefined) return undefined
  const to = classifier.classify(target)
  if (to.zone === "error") return `${display(fileName)} imports ${display(target)}: ${to.reason}`
  if (to.zone === "library") {
    const reason = browser ? browserDenial(libraryAsImported(to, specifier), specifier) : undefined
    return reason === undefined ? undefined : `"${specifier}" may not reach the browser: ${reason}`
  }
  return importAllowed(from, to.zone)
    ? undefined
    : importRuleMessage(display(fileName), from, display(target), to.zone)
}

/**
 * The zone diagnostics for one file of the app rooted at `appRoot`. A fresh classifier per call keeps a
 * moved file or an edited package declaration from going stale; it costs a few `stat`s per import.
 */
export function zoneDiagnostics(
  tsm: typeof ts,
  source: ts.SourceFile,
  appRoot: string,
  options: ts.CompilerOptions,
): ts.Diagnostic[] {
  const classifier = createZoneClassifier({ appRoot })
  const from = classifier.classify(source.fileName)
  if (from.zone === "error" || from.zone === "library" || from.zone === "generated") return []
  const display = (file: string): string => {
    const rel = relative(classifier.appRoot, real(file)).replaceAll("\\", "/")
    return rel.startsWith("../") || isAbsolute(rel) ? file : rel
  }
  const diagnostics: ts.Diagnostic[] = []
  for (const edge of valueImports(tsm, source)) {
    const target = resolveImport(tsm, source, edge, options)
    const message = edgeProblem(
      classifier,
      display,
      source.fileName,
      from.zone,
      edge.specifier,
      target,
    )
    if (message === undefined) continue
    diagnostics.push({
      file: source,
      start: edge.literal.getStart(source),
      length: edge.literal.getWidth(source),
      messageText: message,
      category: tsm.DiagnosticCategory.Error,
      code: ZONE_DIAGNOSTIC_CODE,
      source: "nifra",
    })
  }
  return diagnostics
}
