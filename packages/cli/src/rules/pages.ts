/**
 * NF-C027: a page file whose URL sits under the backend's mount path.
 *
 * `backend/app.ts`'s backend is mounted at `apiPrefix`, when one is set, ahead of page routing, and
 * its 404 is final, so `routes/api/report.tsx` never renders - every request for it gets the
 * backend's 404. `createWebApp` refuses such an app at startup and `nifra build` refuses to build
 * it; this reports it earlier, without running app code (check's pre-`loadApp` invariant): the
 * routes come from a scan of `routes/`, and `apiPrefix` is read only when backend/framework.ts
 * declares it as a string literal.
 *
 * Mounts other than the backend's hold `app` objects no static read can see, so they are left to the
 * startup and build checks.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { discoverRoutes } from "@nifrajs/web/fs"
import { BACKEND_ROUTE_EXPORTS, shadowedPages } from "@nifrajs/web/route-manifest"
import type * as TSApi from "typescript"
import { BACKEND_APP_FILE, CONFIG_FILE, FRAMEWORK_FILE } from "../app-files.ts"
import { stripComments } from "../check-scan.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { codeUnitOrder } from "../internal/code-unit-order.ts"
import { hasWebConfig } from "../internal/nifra-project.ts"
import { scriptKindOf } from "../internal/script-kind.ts"
import type { CheckRule } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

/** What a static read of a framework config says about `apiPrefix`. */
export type StaticApiPrefix =
  | { readonly kind: "default" }
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "unreadable" }

const LITERAL_EXPORT =
  /\bexport\s+const\s+apiPrefix\s*(?::\s*string\s*)?=\s*(?:"([^"\\\r\n]*)"|'([^'\\\r\n]*)')\s*(?:as\s+const\s*)?(?:;|\r?\n|$)/
const MENTION = /\bapiPrefix\b/
const BACKEND_EXPORT =
  /\bexport\s+(?:const|let|var|function|class)\s+backend\b|\bexport\s*\{[^}]*\bbackend\b[^}]*\}/

/** Read `apiPrefix` from a framework config's source without running it. Pure. */
export function readStaticApiPrefix(source: string): StaticApiPrefix {
  const code = stripComments(source)
  const literal = LITERAL_EXPORT.exec(code)
  if (literal !== null) return { kind: "literal", value: literal[1] ?? literal[2] ?? "" }
  return MENTION.test(code) ? { kind: "unreadable" } : { kind: "default" }
}

const CONFIG_FILES = [FRAMEWORK_FILE, CONFIG_FILE] as const

export const shadowedPageRule: CheckRule = {
  code: "NF-C027",
  title: "Page route under the backend mount",
  async scan(ctx) {
    const backendFile = join(ctx.root, BACKEND_APP_FILE)
    const routesDir = join(ctx.root, "routes")
    if (!existsSync(backendFile) || !existsSync(routesDir)) return []
    if (!BACKEND_EXPORT.test(stripComments(readFileSync(backendFile, "utf8")))) return []

    let apiPrefix = ""
    // backend/framework.ts first: the generated server entry imports from it, and the build refuses
    // a nifra.config.ts whose forwarded fields differ from it.
    const configFile = CONFIG_FILES.find((file) => existsSync(join(ctx.root, file)))
    if (configFile !== undefined) {
      const read = readStaticApiPrefix(readFileSync(join(ctx.root, configFile), "utf8"))
      if (read.kind === "unreadable") {
        return [
          diagnostic({
            code: "NF-C027",
            severity: "info",
            file: configFile,
            message: `apiPrefix in ${configFile} is not a string literal, so check cannot tell which page routes sit under the backend mount; createWebApp still refuses a page under it at startup, and nifra build at build time`,
            verify: "nifra build",
          }),
        ]
      }
      if (read.kind === "literal") apiPrefix = read.value
    }
    if (apiPrefix === "") return []

    let manifest: ReturnType<typeof discoverRoutes>
    try {
      manifest = discoverRoutes(routesDir)
    } catch {
      // A routes/ tree the manifest refuses fails dev and build with its own error.
      return []
    }
    const findings: Diagnostic[] = []
    for (const page of shadowedPages(manifest, [apiPrefix])) {
      findings.push(
        diagnostic({
          code: "NF-C027",
          severity: "error",
          file: `routes/${page.file}`,
          message: `routes/${page.file} serves ${page.pattern}, under the backend mounted at ${page.mount} - the backend answers every request there before page routing and its 404 is final, so this page can never render. Move the file out of ${page.mount}, serve the URL from backend/app.ts, or change the mount path with \`export const apiPrefix = "/backend"\` in backend/framework.ts`,
          evidence: [`page: ${page.pattern}`, `mount: ${page.mount}`],
          verify: "nifra check",
        }),
      )
    }
    return findings
  },
}

const IN_LAYOUTS = /\binLayouts\b/

/** An import of the root layout from a page beside it, statically or dynamically. */
const importsRootLayout = (code: string, layoutFile: string): boolean => {
  const stem = layoutFile.replace(/\.[^./]+$/, "")
  return [`"./${stem}`, `'./${stem}`].some((quoted) =>
    [`${quoted}"`, `${quoted}'`, `${quoted}.`].some((opening) => {
      for (let at = code.indexOf(opening); at !== -1; at = code.indexOf(opening, at + 1)) {
        const before = code.slice(Math.max(0, at - 16), at)
        if (/(?:\bfrom|\bimport)\s*\(?\s*$/.test(before)) return true
      }
      return false
    }),
  )
}

/**
 * NF-C034: a root status page (`_404`, `_<status>`) beside a root `_layout` that imports that layout
 * to wrap itself. Status pages render inside their layouts, so such a page renders the layout twice.
 * A page that names `inLayouts` at all has decided, so it is not reported.
 */
export const statusLayoutRule: CheckRule = {
  code: "NF-C034",
  title: "Root status page wraps the root layout itself",
  async scan(ctx) {
    const routesDir = join(ctx.root, "routes")
    if (!existsSync(routesDir)) return []
    let manifest: ReturnType<typeof discoverRoutes>
    try {
      manifest = discoverRoutes(routesDir)
    } catch {
      return []
    }
    const layout = manifest.layouts._layout
    if (layout === undefined) return []
    const pages = [
      ...(manifest.notFound === undefined ? [] : [manifest.notFound.file]),
      ...Object.values(manifest.statusPages ?? {}).map((page) => page.file),
    ]
    const findings: Diagnostic[] = []
    for (const file of pages.sort()) {
      const source = stripComments(readFileSync(join(routesDir, file), "utf8"))
      if (IN_LAYOUTS.test(source) || !importsRootLayout(source, layout.file)) continue
      findings.push(
        diagnostic({
          code: "NF-C034",
          severity: "warn",
          file: `routes/${file}`,
          message: `routes/${file} imports routes/${layout.file} to wrap itself, and status pages render inside their layouts, so it renders routes/${layout.file} twice. Remove the wrap, or add \`export const inLayouts = false\` to keep rendering the page alone.`,
          evidence: [`layout: routes/${layout.file}`],
          verify: "nifra check",
        }),
      )
    }
    return findings
  },
}

/** The two framework configs' sources, `undefined` for one the app lacks. */
export interface ApiPrefixSources {
  readonly framework: string | undefined
  readonly config: string | undefined
}

/** `apiPrefix` as the app runs it: nifra.config.ts's own, else backend/framework.ts's, which every
 * command takes for an option nifra.config.ts leaves unset. */
function effectiveApiPrefix({ framework, config }: ApiPrefixSources): StaticApiPrefix {
  const own: StaticApiPrefix =
    config === undefined ? { kind: "default" } : readStaticApiPrefix(config)
  return own.kind !== "default" || framework === undefined ? own : readStaticApiPrefix(framework)
}

/**
 * NF-C035: `backend/app.ts` exports a backend that is not served over HTTP, so a browser call to `/api`
 * reaches page routing. The framework config sets no `apiPrefix`; loader-only is a valid choice, and
 * the finding asks for it to be stated. An unreadable `apiPrefix` is NF-C027's.
 */
export const implicitApiMountRule: CheckRule = {
  code: "NF-C035",
  title: "Backend not served over HTTP",
  async scan(ctx) {
    const backendFile = join(ctx.root, BACKEND_APP_FILE)
    // An API-only app serves its backend itself; there is no page routing to fall into.
    if (!existsSync(backendFile) || !hasWebConfig(ctx.root, ".")) return []
    if (!BACKEND_EXPORT.test(stripComments(readFileSync(backendFile, "utf8")))) return []
    const read = (file: string): string | undefined =>
      existsSync(join(ctx.root, file)) ? readFileSync(join(ctx.root, file), "utf8") : undefined
    const sources = { framework: read(FRAMEWORK_FILE), config: read(CONFIG_FILE) }
    if (sources.framework === undefined && sources.config === undefined) return []
    if (effectiveApiPrefix(sources).kind !== "default") return []
    const file = sources.framework === undefined ? CONFIG_FILE : FRAMEWORK_FILE
    return [
      diagnostic({
        code: "NF-C035",
        severity: "warn",
        file,
        message: `${BACKEND_APP_FILE}'s backend is not served over HTTP, because ${file} sets no apiPrefix: a browser call to /api reaches page routing instead. Add \`export const apiPrefix = "/api"\` to ${file} to serve it there, as 4.x did by default, or \`export const apiPrefix = ""\` to keep it loader-only.`,
        fix: { recipe: "framework.api-prefix", command: "nifra fix --code NF-C035" },
        verify: "nifra check",
      }),
    ]
  },
}

const appendLine = (source: string, line: string): string =>
  source === "" ? line : `${source}${source.endsWith("\n") ? "" : "\n"}${line}`

/** Append `export const apiPrefix = "/api"` to a framework config that sets none, creating it if needed. */
export function withDefaultApiPrefix(source: string | undefined): string | undefined {
  if (source !== undefined && readStaticApiPrefix(source).kind !== "default") return undefined
  return appendLine(source ?? "", 'export const apiPrefix = "/api"\n')
}

/**
 * The edit that serves the backend at `/api`: the mount in backend/framework.ts, where the server
 * entry reads it, or in nifra.config.ts when it is the only config. A file that needs no edit comes
 * back `undefined`; an `apiPrefix` either file sets is never replaced.
 */
export function apiPrefixFix(sources: ApiPrefixSources): ApiPrefixSources {
  if (effectiveApiPrefix(sources).kind !== "default")
    return { framework: undefined, config: undefined }
  return sources.framework === undefined
    ? { framework: undefined, config: withDefaultApiPrefix(sources.config) }
    : { framework: withDefaultApiPrefix(sources.framework), config: undefined }
}

const LOADER_EXPORT =
  /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?)\s+loader\b|\bexport\s*\{[^}]*\bloader\b[^}]*\}/
const SCRIPT_LAYOUT = /\.[cm]?[jt]sx?$/

// Read from the node, not `ts.getModifiers`: TypeScript 7's API has no getModifiers or canHaveModifiers.
const hasModifier = (
  node: TSApi.VariableStatement | TSApi.FunctionDeclaration | TSApi.ClassDeclaration,
  kind: TSApi.SyntaxKind,
): boolean => node.modifiers?.some((m) => m.kind === kind) === true

/** The function an exported `meta` names: a declaration, or a const initialized with one. */
function exportedMetaFunction(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
): TSApi.FunctionDeclaration | TSApi.ArrowFunction | TSApi.FunctionExpression | undefined {
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name?.text === "meta" && hasModifier(statement, ts.SyntaxKind.ExportKeyword))
        return statement
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "meta") continue
      let init = declaration.initializer
      while (
        init !== undefined &&
        (ts.isParenthesizedExpression(init) ||
          ts.isAsExpression(init) ||
          ts.isSatisfiesExpression(init))
      ) {
        init = init.expression
      }
      if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
        return init
    }
  }
  return undefined
}

/** Where an exported function `meta` reads its args' `data`: a destructured `data`, or `args.data`. */
export function metaDataReads(ts: typeof TSApi, tree: TSApi.SourceFile): number[] {
  const meta = exportedMetaFunction(ts, tree)
  const param = meta?.parameters[0]
  if (param === undefined) return []
  const lineOf = (node: TSApi.Node) =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
  if (ts.isObjectBindingPattern(param.name)) {
    return param.name.elements
      .filter((element) => (element.propertyName ?? element.name).getText(tree) === "data")
      .map(lineOf)
  }
  if (!ts.isIdentifier(param.name) || meta?.body === undefined) return []
  const args = param.name.text
  const reads: number[] = []
  const visit = (node: TSApi.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === args &&
      node.name.text === "data"
    ) {
      reads.push(lineOf(node))
    }
    ts.forEachChild(node, visit)
  }
  visit(meta.body)
  return reads
}

/**
 * NF-C040: a layout whose function `meta` reads `data` and which has no loader. A layout's `meta`
 * receives its own loader data, `null` without a loader, so `data` there is always `null`; the page's
 * data is `pageData`. Until 5.0 a layout's `meta` received the page's data as `data`, which is what such
 * a `meta` was written against. A layout with a loader reading `data` reads its own, so it is not reported.
 */
export const layoutMetaDataRule: CheckRule = {
  code: "NF-C040",
  title: "Layout meta reads data its layout never loads",
  async scan(ctx) {
    const routesDir = join(ctx.root, "routes")
    if (!existsSync(routesDir)) return []
    let manifest: ReturnType<typeof discoverRoutes>
    try {
      manifest = discoverRoutes(routesDir)
    } catch {
      return []
    }
    const layouts = Object.values(manifest.layouts)
      .filter((layout) => SCRIPT_LAYOUT.test(layout.file))
      .sort((a, b) => codeUnitOrder(a.file, b.file))
    if (layouts.length === 0) return []
    const loaded = await loadRuleTypeScript(ctx)
    const ts = loaded.compiler
    if (ts === undefined) return []
    const findings: Diagnostic[] = []
    for (const layout of layouts) {
      const halves = [layout.file, ...(layout.backend === undefined ? [] : [layout.backend])]
      const loads = halves.some((file) =>
        LOADER_EXPORT.test(stripComments(readFileSync(join(routesDir, file), "utf8"))),
      )
      if (loads) continue
      const text = readFileSync(join(routesDir, layout.file), "utf8")
      const tree = ts.createSourceFile(
        layout.file,
        text,
        ts.ScriptTarget.Latest,
        true,
        scriptKindOf(ts, layout.file),
      )
      for (const line of metaDataReads(ts, tree)) {
        findings.push(
          diagnostic({
            code: "NF-C040",
            severity: "warn",
            file: `routes/${layout.file}`,
            line,
            message: `routes/${layout.file}'s meta reads \`data\`, which is this layout's own loader data, and the layout has no loader, so it is always null. Read the page's data from \`pageData\` instead.`,
            evidence: [
              "data: the layout's loader data (null without a loader)",
              "pageData: the page's loader data",
            ],
            verify: "nifra check",
          }),
        )
      }
    }
    return findings
  },
}

/** The names a module exports at runtime, each with its line: declarations and `export { ... }` lists.
 * `export *` names nothing it can read, and type-only exports carry no value. */
function runtimeExports(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
): Array<{ readonly name: string; readonly line: number }> {
  const found: Array<{ name: string; line: number }> = []
  const add = (name: string, node: TSApi.Node): void => {
    found.push({ name, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
  }
  for (const statement of tree.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || statement.exportClause === undefined) continue
      if (!ts.isNamedExports(statement.exportClause)) continue
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) add(element.name.text, element)
      }
      continue
    }
    if (
      !(
        ts.isVariableStatement(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)
      ) ||
      !hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
      hasModifier(statement, ts.SyntaxKind.DeclareKeyword)
    )
      continue
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) add(declaration.name.text, declaration)
      }
    } else if (statement.name !== undefined) {
      add(statement.name.text, statement)
    }
  }
  return found
}

/**
 * NF-C041: a route's frontend file (`x.tsx`, a layout, a status or error page) exports a name only
 * the server reads, such as `loader` or `action`. The frontend file ships to the browser whole, so
 * `nifra build` and the server refuse it; this reports it before either runs.
 */
export const frontendServerExportRule: CheckRule = {
  code: "NF-C041",
  title: "Server-only export in a route frontend file",
  async scan(ctx) {
    const routesDir = join(ctx.root, "routes")
    if (!existsSync(routesDir)) return []
    let manifest: ReturnType<typeof discoverRoutes>
    try {
      manifest = discoverRoutes(routesDir)
    } catch {
      return []
    }
    const files = new Set<string>()
    for (const entry of [
      ...manifest.routes,
      ...Object.values(manifest.layouts),
      ...Object.values(manifest.errors ?? {}),
      ...(manifest.notFound === undefined ? [] : [manifest.notFound]),
      ...Object.values(manifest.notFounds ?? {}),
      ...Object.values(manifest.statusPages ?? {}),
      ...Object.values(manifest.loadings ?? {}),
    ]) {
      if (SCRIPT_LAYOUT.test(entry.file)) files.add(entry.file)
    }
    if (files.size === 0) return []
    const loaded = await loadRuleTypeScript(ctx)
    const ts = loaded.compiler
    if (ts === undefined) return []
    const findings: Diagnostic[] = []
    for (const file of [...files].sort(codeUnitOrder)) {
      const text = readFileSync(join(routesDir, file), "utf8")
      const tree = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        scriptKindOf(ts, file),
      )
      for (const { name, line } of runtimeExports(ts, tree)) {
        if (!BACKEND_ROUTE_EXPORTS.has(name)) continue
        const backend = `routes/${file.replace(SCRIPT_LAYOUT, ".backend.ts")}`
        findings.push(
          diagnostic({
            code: "NF-C041",
            severity: "error",
            file: `routes/${file}`,
            line,
            message: `routes/${file} exports "${name}", which runs on the server only, and a route's frontend file ships to the browser whole, so nifra build and the server refuse it. Move it to ${backend}.`,
            evidence: [`export: ${name}`, `backend half: ${backend}`],
            fix: { recipe: "route.split", command: "nifra fix --code NF-C041" },
            verify: "nifra check",
          }),
        )
      }
    }
    return findings
  },
}

export const pageRules = Object.freeze([
  shadowedPageRule,
  statusLayoutRule,
  implicitApiMountRule,
  layoutMetaDataRule,
  frontendServerExportRule,
])
