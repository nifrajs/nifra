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
import { join, posix } from "node:path"
import { discoverRoutes } from "@nifrajs/web/fs"
import { BACKEND_ROUTE_EXPORTS, shadowedPages } from "@nifrajs/web/route-manifest"
import type * as TSApi from "typescript"
import { BACKEND_APP_FILE, CONFIG_FILE, FRAMEWORK_FILE } from "../app-files.ts"
import { stripComments } from "../check-scan.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { codeUnitOrder } from "../internal/code-unit-order.ts"
import { hasWebConfig } from "../internal/nifra-project.ts"
import { scriptKindOf } from "../internal/script-kind.ts"
import { commentBlockExpectation } from "./comment-markers.ts"
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

/** What a `createWebApp` call passes as `apiPrefix`: a value, the framework config's own, or neither. */
type EntryApiPrefix =
  | { readonly kind: "literal"; readonly value: string; readonly unset: boolean }
  | { readonly kind: "config" }
  | { readonly kind: "unreadable" }

const SCRIPT_SOURCE = /\.[cm]?[jt]sx?$/
const WEB_PACKAGE = "@nifrajs/web"
const CONFIG_MODULES: ReadonlySet<string> = new Set(
  [FRAMEWORK_FILE, CONFIG_FILE].map((file) => file.replace(SCRIPT_SOURCE, "")),
)

/** Whether a relative specifier in `file` names backend/framework.ts or nifra.config.ts. */
const namesFrameworkConfig = (file: string, specifier: string): boolean =>
  specifier.startsWith(".") &&
  CONFIG_MODULES.has(posix.join(posix.dirname(file), specifier).replace(SCRIPT_SOURCE, ""))

const unwrapExpression = (ts: typeof TSApi, node: TSApi.Expression): TSApi.Expression => {
  let expr = node
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr)
  ) {
    expr = expr.expression
  }
  return expr
}

/** A `createWebApp` call that mounts a backend (`api`), with the `apiPrefix` it passes. */
export interface EntryApiMount {
  readonly line: number
  readonly apiPrefix: EntryApiPrefix
  /** The line of the `apiPrefix` property that decides it, when one does. */
  readonly prefixLine: number | undefined
}

/**
 * Every `createWebApp({ api, ... })` call in a module, `createWebApp` imported from `@nifrajs/web`.
 * `apiPrefix` reads as a string literal, a same-module string `const`, or the framework config's own
 * export (`import { apiPrefix } from "./backend/framework"`); a call whose options come from a spread
 * or a variable is unreadable. A call with no `api` mounts nothing and is left out. Pure.
 */
export function entryApiMounts(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
  file: string,
): EntryApiMount[] {
  const webNames = new Set<string>()
  const webNamespaces = new Set<string>()
  const configNames = new Set<string>()
  const configNamespaces = new Set<string>()
  const strings = new Map<string, string>()
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const from = statement.moduleSpecifier.text
      const bindings = statement.importClause?.namedBindings
      const isWeb = from === WEB_PACKAGE
      const isConfig = namesFrameworkConfig(file, from)
      if (bindings === undefined || (!isWeb && !isConfig)) continue
      if (ts.isNamespaceImport(bindings)) {
        ;(isWeb ? webNamespaces : configNamespaces).add(bindings.name.text)
        continue
      }
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text
        if (isWeb && imported === "createWebApp") webNames.add(element.name.text)
        if (isConfig && imported === "apiPrefix") configNames.add(element.name.text)
      }
      continue
    }
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    )
      continue
    for (const declaration of statement.declarationList.declarations) {
      const init =
        declaration.initializer === undefined
          ? undefined
          : unwrapExpression(ts, declaration.initializer)
      if (
        ts.isIdentifier(declaration.name) &&
        init !== undefined &&
        (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))
      )
        strings.set(declaration.name.text, init.text)
    }
  }
  if (webNames.size === 0 && webNamespaces.size === 0) return []

  const readPrefix = (node: TSApi.Expression): EntryApiPrefix => {
    const expr = unwrapExpression(ts, node)
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
      return { kind: "literal", value: expr.text, unset: false }
    if (ts.isIdentifier(expr)) {
      if (configNames.has(expr.text)) return { kind: "config" }
      const value = strings.get(expr.text)
      return value === undefined ? { kind: "unreadable" } : { kind: "literal", value, unset: false }
    }
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      configNamespaces.has(expr.expression.text) &&
      expr.name.text === "apiPrefix"
    )
      return { kind: "config" }
    return { kind: "unreadable" }
  }
  const isCreateWebApp = (callee: TSApi.Expression): boolean =>
    ts.isIdentifier(callee)
      ? webNames.has(callee.text)
      : ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        webNamespaces.has(callee.expression.text) &&
        callee.name.text === "createWebApp"
  const propertyName = (property: TSApi.ObjectLiteralElementLike): string | undefined =>
    property.name !== undefined &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ? property.name.text
      : undefined

  const mounts: EntryApiMount[] = []
  const visit = (node: TSApi.Node): void => {
    const arg = ts.isCallExpression(node) ? node.arguments[0] : undefined
    const options = arg === undefined ? undefined : unwrapExpression(ts, arg)
    if (
      ts.isCallExpression(node) &&
      isCreateWebApp(node.expression) &&
      options !== undefined &&
      ts.isObjectLiteralExpression(options) &&
      options.properties.some((property) => propertyName(property) === "api")
    ) {
      // The last of an `apiPrefix` property and a spread decides, as it does at runtime.
      let apiPrefix: EntryApiPrefix = { kind: "literal", value: "", unset: true }
      let prefixNode: TSApi.Node | undefined
      for (const property of options.properties) {
        if (ts.isSpreadAssignment(property)) apiPrefix = { kind: "unreadable" }
        else if (propertyName(property) !== "apiPrefix") continue
        else if (ts.isPropertyAssignment(property)) apiPrefix = readPrefix(property.initializer)
        else if (ts.isShorthandPropertyAssignment(property)) apiPrefix = readPrefix(property.name)
        else apiPrefix = { kind: "unreadable" }
        prefixNode = ts.isSpreadAssignment(property) ? undefined : property
      }
      const lineOf = (at: TSApi.Node): number =>
        tree.getLineAndCharacterOfPosition(at.getStart(tree)).line + 1
      mounts.push({
        line: lineOf(node),
        apiPrefix,
        prefixLine: prefixNode === undefined ? undefined : lineOf(prefixNode),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return mounts
}

const ENTRY_PREFIX_EXPECTATION = ["NF-C035"]

const servedAt = (prefix: string): string => (prefix === "" ? "nowhere" : `at ${prefix}`)

/**
 * The NF-C035 findings for app modules that start their own server: a `createWebApp` call that
 * mounts a backend at a different `apiPrefix` than the one `nifra dev` reads, or with none, so
 * production serves the backend somewhere dev and e2e never exercised.
 */
async function entryApiPrefixFindings(
  ctx: Parameters<CheckRule["scan"]>[0],
  expected: string,
  origin: string,
): Promise<Diagnostic[]> {
  const candidates = ctx.sources.files.filter(
    (file) => SCRIPT_SOURCE.test(file) && ctx.sources.read(file)?.includes("createWebApp") === true,
  )
  if (candidates.length === 0) return []
  const ts = (await loadRuleTypeScript(ctx)).compiler
  if (ts === undefined) return []
  const findings: Diagnostic[] = []
  for (const file of [...candidates].sort(codeUnitOrder)) {
    const text = ctx.sources.read(file) ?? ""
    const tree = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKindOf(ts, file),
    )
    const lines = text.split("\n")
    for (const { line, apiPrefix, prefixLine } of entryApiMounts(ts, tree, file)) {
      if (apiPrefix.kind !== "literal" || apiPrefix.value === expected) continue
      if (
        [line, prefixLine].some(
          (at) => at !== undefined && commentBlockExpectation(lines, at, ENTRY_PREFIX_EXPECTATION),
        )
      )
        continue
      const specifier = posix.relative(posix.dirname(file), origin.replace(SCRIPT_SOURCE, ""))
      const passed = apiPrefix.unset
        ? "no apiPrefix"
        : `apiPrefix ${JSON.stringify(apiPrefix.value)}`
      const hatch =
        expected === ""
          ? "Mark a deliberate difference with `// nifra-expect NF-C035: <reason>` above the call."
          : `If another server already serves this backend at ${expected}, mark the call with \`// nifra-expect NF-C035: <reason>\` instead${apiPrefix.value === "" ? ": an apiPrefix here would add a second path to it that skips that server's middleware" : ""}.`
      findings.push(
        diagnostic({
          code: "NF-C035",
          severity: "warn",
          file,
          line,
          message: `${file} calls createWebApp with a backend and ${passed}, so the server it starts serves the backend ${servedAt(apiPrefix.value)}, while \`nifra dev\` serves it ${servedAt(expected)} (${origin}). Pass the framework config's value: \`import { apiPrefix } from "${specifier.startsWith(".") ? specifier : `./${specifier}`}"\` and \`createWebApp({ ..., apiPrefix })\`. ${hatch}`,
          evidence: [
            `createWebApp apiPrefix: ${apiPrefix.unset ? "unset" : JSON.stringify(apiPrefix.value)}`,
            `${origin} apiPrefix: ${JSON.stringify(expected)}`,
          ],
          verify: "nifra check",
        }),
      )
    }
  }
  return findings
}

/**
 * NF-C035: `backend/app.ts` exports a backend that is not served over HTTP, so a browser call to `/api`
 * reaches page routing. The framework config sets no `apiPrefix`; loader-only is a valid choice, and
 * the finding asks for it to be stated. An unreadable `apiPrefix` is NF-C027's.
 *
 * An app module that calls `createWebApp` itself is checked against the same value, since only the
 * framework config reaches `nifra dev`: a backend it mounts at another `apiPrefix`, or with none, is
 * served in production where dev never served it. No static read sees a mount another server makes,
 * so `// nifra-expect NF-C035: <reason>` on the call or its `apiPrefix` line accepts the difference.
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
    const effective = effectiveApiPrefix(sources)
    if (effective.kind === "unreadable") return []
    const configOwn = sources.config === undefined ? undefined : readStaticApiPrefix(sources.config)
    const origin =
      configOwn !== undefined && (configOwn.kind !== "default" || sources.framework === undefined)
        ? CONFIG_FILE
        : FRAMEWORK_FILE
    const entries = await entryApiPrefixFindings(
      ctx,
      effective.kind === "literal" ? effective.value : "",
      origin,
    )
    if (effective.kind === "literal") return entries
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
      ...entries,
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

/** The function an exported `name` names: a declaration, or a const initialized with one. */
function exportedFunction(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
  name: string,
): TSApi.FunctionDeclaration | TSApi.ArrowFunction | TSApi.FunctionExpression | undefined {
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name?.text === name && hasModifier(statement, ts.SyntaxKind.ExportKeyword))
        return statement
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
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
  const meta = exportedFunction(ts, tree, "meta")
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

const GATE_EXPORT = /\bexport\s+const\s+gate\s*(?::\s*boolean\s*)?=\s*true\b/
const MIDDLEWARE_EXPORT =
  /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?)\s+middleware\b|\bexport\s*\{[^}]*\bmiddleware\b[^}]*\}/

/** Lines where an exported `loader` refuses access: `redirect()`, `statusPage(401|403)`, `new Response()`. */
export function loaderRefusals(ts: typeof TSApi, tree: TSApi.SourceFile): number[] {
  const loader = exportedFunction(ts, tree, "loader")
  if (loader?.body === undefined) return []
  const lines: number[] = []
  const lineOf = (node: TSApi.Node): number =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
  const visit = (node: TSApi.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const status = node.arguments[0]
      if (
        node.expression.text === "redirect" ||
        (node.expression.text === "statusPage" &&
          status !== undefined &&
          ts.isNumericLiteral(status) &&
          (status.text === "401" || status.text === "403"))
      )
        lines.push(lineOf(node))
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Response"
    ) {
      lines.push(lineOf(node))
    }
    ts.forEachChild(node, visit)
  }
  visit(loader.body)
  return lines
}

/**
 * NF-C042: a layout loader that refuses access - a redirect, a 401 or 403, a `Response` - in a layout
 * that is not a gate and exports no middleware. A client navigation that keeps the layout skips that
 * loader, and an action below it runs without it, so the check reads as a guard and is not one. A
 * refusal inside a helper the loader calls is not seen; the development warning covers that.
 */
export const ungatedLayoutRefusalRule: CheckRule = {
  code: "NF-C042",
  title: "Layout loader refuses access without a gate",
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
    const sources = layouts.map((layout) =>
      [layout.file, ...(layout.backend === undefined ? [] : [layout.backend])].map((file) => ({
        file,
        text: readFileSync(join(routesDir, file), "utf8"),
      })),
    )
    if (!sources.flat().some((half) => LOADER_EXPORT.test(stripComments(half.text)))) return []
    const loaded = await loadRuleTypeScript(ctx)
    const ts = loaded.compiler
    if (ts === undefined) return []
    const findings: Diagnostic[] = []
    for (const halves of sources) {
      const code = halves.map((half) => stripComments(half.text))
      if (code.some((text) => GATE_EXPORT.test(text) || MIDDLEWARE_EXPORT.test(text))) continue
      for (const half of halves) {
        if (!LOADER_EXPORT.test(stripComments(half.text))) continue
        const tree = ts.createSourceFile(
          half.file,
          half.text,
          ts.ScriptTarget.Latest,
          true,
          scriptKindOf(ts, half.file),
        )
        const [line] = loaderRefusals(ts, tree)
        if (line === undefined) continue
        findings.push(
          diagnostic({
            code: "NF-C042",
            severity: "warn",
            file: `routes/${half.file}`,
            line,
            message: `routes/${half.file}'s loader refuses access, but the layout is not a gate. A client navigation that keeps the layout skips this loader, and an action below it runs without it, so it does not protect the pages under it. Export \`gate = true\` from this file, or move the check into its \`middleware\`.`,
            evidence: [
              "gate = true: the loader runs on every request and before every action, ahead of the page loader",
              "middleware: runs before every page and action below the directory",
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
  ungatedLayoutRefusalRule,
])
