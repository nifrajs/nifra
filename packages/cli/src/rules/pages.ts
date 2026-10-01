/**
 * NF-C027: a page file whose URL sits under the backend's mount path.
 *
 * `backend.ts`'s backend is mounted at `apiPrefix` (default `/api`) ahead of page routing, and its 404
 * is final, so `routes/api/report.tsx` never renders - every request for it gets the backend's 404.
 * `createWebApp` refuses such an app at startup and `nifra build` refuses to build it; this reports it
 * earlier, without running app code (check's pre-`loadApp` invariant): the routes come from a scan of
 * `routes/`, and `apiPrefix` is read only when framework.ts declares it as a string literal.
 *
 * Mounts other than the backend's hold `app` objects no static read can see, so they are left to the
 * startup and build checks.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { discoverRoutes } from "@nifrajs/web/fs"
import { shadowedPages } from "@nifrajs/web/route-manifest"
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

const CONFIG_FILES = ["framework.ts", "nifra.config.ts"] as const

export const shadowedPageRule: CheckRule = {
  code: "NF-C027",
  title: "Page route under the backend mount",
  async scan(ctx) {
    const backendFile = join(ctx.root, "backend.ts")
    const routesDir = join(ctx.root, "routes")
    if (!existsSync(backendFile) || !existsSync(routesDir)) return []
    if (!BACKEND_EXPORT.test(stripComments(readFileSync(backendFile, "utf8")))) return []

    let apiPrefix = "/api"
    // framework.ts first: the generated server entry imports from it, and the build refuses a
    // nifra.config.ts whose forwarded fields differ from it.
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
          message: `routes/${page.file} serves ${page.pattern}, under the backend mounted at ${page.mount} - the backend answers every request there before page routing and its 404 is final, so this page can never render. Move the file out of ${page.mount}, serve the URL from backend.ts, or change the mount path with \`export const apiPrefix = "/backend"\` in framework.ts`,
          evidence: [`page: ${page.pattern}`, `mount: ${page.mount}`],
          verify: "nifra check",
        }),
      )
    }
    return findings
  },
}

export const pageRules = Object.freeze([shadowedPageRule])
