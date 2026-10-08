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
import { BACKEND_APP_FILE, CONFIG_FILE, FRAMEWORK_FILE } from "../app-files.ts"
import { stripComments } from "../check-scan.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import type { CheckRule } from "./index.ts"

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

/**
 * NF-C035: `backend/app.ts` exports a backend and the framework config sets no `apiPrefix`, so the
 * backend is not served over HTTP - a browser call to `/api` reaches page routing. Loader-only is a
 * valid choice; the finding asks for it to be stated. An unreadable `apiPrefix` is NF-C027's to report.
 */
export const implicitApiMountRule: CheckRule = {
  code: "NF-C035",
  title: "Backend not served over HTTP",
  async scan(ctx) {
    const backendFile = join(ctx.root, BACKEND_APP_FILE)
    if (!existsSync(backendFile)) return []
    if (!BACKEND_EXPORT.test(stripComments(readFileSync(backendFile, "utf8")))) return []
    const configFile = CONFIG_FILES.find((file) => existsSync(join(ctx.root, file)))
    if (
      configFile !== undefined &&
      readStaticApiPrefix(readFileSync(join(ctx.root, configFile), "utf8")).kind !== "default"
    ) {
      return []
    }
    const file = configFile ?? FRAMEWORK_FILE
    return [
      diagnostic({
        code: "NF-C035",
        severity: "info",
        file,
        message: `${BACKEND_APP_FILE}'s backend is not served over HTTP, because ${file} sets no apiPrefix: a browser call to /api reaches page routing instead. Add \`export const apiPrefix = "/api"\` to ${file} to serve it there, as 4.x did by default, or \`export const apiPrefix = ""\` to keep it loader-only.`,
        fix: { recipe: "framework.api-prefix", command: "nifra fix --code NF-C035" },
        verify: "nifra check",
      }),
    ]
  },
}

/** Append `export const apiPrefix = "/api"` to a framework config that sets none, creating it if needed. */
export function withDefaultApiPrefix(source: string | undefined): string | undefined {
  if (source !== undefined && readStaticApiPrefix(source).kind !== "default") return undefined
  const line = 'export const apiPrefix = "/api"\n'
  if (source === undefined || source === "") return line
  return `${source}${source.endsWith("\n") ? "" : "\n"}${line}`
}

export const pageRules = Object.freeze([shadowedPageRule, statusLayoutRule, implicitApiMountRule])
