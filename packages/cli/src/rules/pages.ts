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
import { shadowedPages } from "@nifrajs/web/route-manifest"
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

const FRAMEWORK_MODULE = String.raw`\.\/backend\/framework(?:\.[cm]?[jt]s)?`
const FRAMEWORK_STAR = new RegExp(String.raw`\bexport\s*\*\s*from\s*["']${FRAMEWORK_MODULE}["']`)
const FRAMEWORK_SPECIFIER = new RegExp(String.raw`\bfrom\s*["'](${FRAMEWORK_MODULE})["']`)

/** The two framework configs' sources, `undefined` for one the app lacks. Production's generated server
 * entry imports backend/framework.ts when it exists, while `nifra dev` loads nifra.config.ts when it
 * exists. */
export interface ApiPrefixSources {
  readonly framework: string | undefined
  readonly config: string | undefined
}

/** `apiPrefix` as nifra.config.ts exports it when backend/framework.ts exists too: its own, or every
 * export of backend/framework.ts through `export *`. */
function configApiPrefix(config: string, framework: StaticApiPrefix): StaticApiPrefix {
  const own = readStaticApiPrefix(config)
  if (own.kind !== "default") return own
  return FRAMEWORK_STAR.test(stripComments(config)) ? framework : own
}

/** Whether a read leaves the backend unmounted: no `apiPrefix`, or an empty one. */
const unmounted = (read: StaticApiPrefix): boolean =>
  read.kind === "default" || (read.kind === "literal" && read.value === "")

/**
 * NF-C035: `backend/app.ts` exports a backend that is not served over HTTP, so a browser call to `/api`
 * reaches page routing. Either the framework config sets no `apiPrefix` (loader-only is a valid choice;
 * the finding asks for it to be stated), or backend/framework.ts sets one that nifra.config.ts does not
 * export, so `nifra dev` alone leaves the backend unmounted. An unreadable `apiPrefix` is NF-C027's.
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
    const framework = read(FRAMEWORK_FILE)
    const config = read(CONFIG_FILE)
    const served = framework ?? config
    if (served === undefined) return []
    const production = readStaticApiPrefix(served)
    const dev =
      framework !== undefined && config !== undefined
        ? configApiPrefix(config, production)
        : production

    if (production.kind === "default") {
      // nifra.config.ts setting what backend/framework.ts does not fails `nifra dev` and `nifra build`
      // at load, naming the field.
      if (dev.kind !== "default") return []
      const file = framework === undefined ? CONFIG_FILE : FRAMEWORK_FILE
      const reexport =
        config === undefined || framework === undefined
          ? ""
          : `, and re-export it from ${CONFIG_FILE}, which nifra dev loads: \`export { apiPrefix } from "${frameworkSpecifier(config)}"\``
      return [
        diagnostic({
          code: "NF-C035",
          severity: "warn",
          file,
          message: `${BACKEND_APP_FILE}'s backend is not served over HTTP, because ${file} sets no apiPrefix: a browser call to /api reaches page routing instead. Add \`export const apiPrefix = "/api"\` to ${file} to serve it there, as 4.x did by default, or \`export const apiPrefix = ""\` to keep it loader-only${reexport}.`,
          fix: { recipe: "framework.api-prefix", command: "nifra fix --code NF-C035" },
          verify: "nifra check",
        }),
      ]
    }
    if (config === undefined || unmounted(production) || !unmounted(dev)) return []
    const at = production.kind === "literal" ? production.value : "the apiPrefix it exports"
    return [
      diagnostic({
        code: "NF-C035",
        severity: "warn",
        file: CONFIG_FILE,
        message: `${FRAMEWORK_FILE} serves ${BACKEND_APP_FILE}'s backend at ${at}, but ${CONFIG_FILE}, which nifra dev loads instead, does not export apiPrefix: nifra dev serves the backend nowhere, so a browser call to it reaches page routing in dev while a production build serves it. Re-export it from ${CONFIG_FILE}: \`export { apiPrefix } from "${frameworkSpecifier(config)}"\`.`,
        evidence: [`production: ${FRAMEWORK_FILE}`, `nifra dev: ${CONFIG_FILE}`],
        fix: { recipe: "framework.api-prefix", command: "nifra fix --code NF-C035" },
        verify: "nifra check",
      }),
    ]
  },
}

/** How nifra.config.ts already names backend/framework.ts, so a re-export added to it resolves the same
 * way; the scaffold's extensionless spelling when it names it nowhere. */
function frameworkSpecifier(config: string): string {
  return FRAMEWORK_SPECIFIER.exec(stripComments(config))?.[1] ?? "./backend/framework"
}

const appendLine = (source: string, line: string): string =>
  source === "" ? line : `${source}${source.endsWith("\n") ? "" : "\n"}${line}`

/** Append `export const apiPrefix = "/api"` to a framework config that sets none, creating it if needed. */
export function withDefaultApiPrefix(source: string | undefined): string | undefined {
  if (source !== undefined && readStaticApiPrefix(source).kind !== "default") return undefined
  return appendLine(source ?? "", 'export const apiPrefix = "/api"\n')
}

/**
 * The edits that serve the backend at `/api` in production and in `nifra dev` alike: the mount where the
 * generated server entry reads it, and a re-export in nifra.config.ts when both configs exist. A file that
 * needs no edit comes back `undefined`; an explicit `apiPrefix` is never replaced.
 */
export function apiPrefixFix(sources: ApiPrefixSources): ApiPrefixSources {
  const { framework, config } = sources
  if (framework === undefined) return { framework, config: withDefaultApiPrefix(config) }
  const nextFramework = withDefaultApiPrefix(framework)
  const production = readStaticApiPrefix(nextFramework ?? framework)
  const reexport =
    config === undefined || configApiPrefix(config, production).kind !== "default"
      ? undefined
      : appendLine(config, `export { apiPrefix } from "${frameworkSpecifier(config)}"\n`)
  return { framework: nextFramework, config: reexport }
}

const LOADER_EXPORT =
  /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?)\s+loader\b|\bexport\s*\{[^}]*\bloader\b[^}]*\}/
const SCRIPT_LAYOUT = /\.[cm]?[jt]sx?$/

const hasModifier = (ts: typeof TSApi, node: TSApi.Node, kind: TSApi.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind)

/** The function an exported `meta` names: a declaration, or a const initialized with one. */
function exportedMetaFunction(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
): TSApi.FunctionDeclaration | TSApi.ArrowFunction | TSApi.FunctionExpression | undefined {
  for (const statement of tree.statements) {
    if (!hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "meta") return statement
    if (!ts.isVariableStatement(statement)) continue
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

export const pageRules = Object.freeze([
  shadowedPageRule,
  statusLayoutRule,
  implicitApiMountRule,
  layoutMetaDataRule,
])
