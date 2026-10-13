import { isAbsolute, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { commentBlockExpectation } from "./comment-markers.ts"
import type { CheckRule, RuleContext } from "./index.ts"

const MERGE_AUTH_EXPECTATION = ["NF-C043", "merge-auth"]
const SHOWN_ROUTES = 5

/** A recorded `file:line:col` as a project-relative POSIX path and line, when it is inside the project. */
function projectSite(
  root: string,
  site: string | undefined,
): { readonly file: string; readonly line: number } | undefined {
  const [, raw, line] = site?.match(/^(.*):(\d+):\d+$/) ?? []
  if (raw === undefined || line === undefined) return undefined
  const path = raw.startsWith("file://") ? fileURLToPath(raw) : raw
  if (!isAbsolute(path)) return undefined
  const rel = relative(root, path)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined
  if (rel.split(sep).includes("node_modules")) return undefined
  return { file: rel.split(sep).join("/"), line: Number(line) }
}

/**
 * NF-C043: a `merge()` under a parent whose order-scoped auth - an `authenticate()` stage, or
 * `authenticated` evidence scoped to subsequent routes - covers the parent's own routes, while the
 * merged server authenticates none of its routes. A merged route keeps the chain of the server that
 * declared it, so the parent's auth never runs for it. Read from the app `nifra.assurance.ts` loads
 * (core records each such merge in a development load). A server that authenticates any route of its
 * own is taken to have chosen its own auth and is not reported. `// nifra-expect NF-C043: <reason>` on
 * the merge line accepts a module that is public on purpose.
 */
export const mergeAuthGapRule: CheckRule = {
  code: "NF-C043",
  title: "Merged routes skip the parent's authentication",
  async scan(ctx: RuleContext) {
    const assurance = ctx.project.policies.assurance
    if (assurance === undefined || assurance.error !== undefined) return []
    const source = assurance.config?.source
    if (source === undefined) return []
    const { reflectMergeAuthGaps } = await import("@nifrajs/core/reflection")
    const findings: Diagnostic[] = []
    for (const gap of reflectMergeAuthGaps(source)) {
      const at = projectSite(ctx.root, gap.site)
      if (at !== undefined) {
        const lines = (ctx.project.source.read(at.file) ?? "").split("\n")
        if (commentBlockExpectation(lines, at.line, MERGE_AUTH_EXPECTATION)?.reason !== undefined)
          continue
      }
      const shown = gap.routes.slice(0, SHOWN_ROUTES).join(", ")
      const more =
        gap.routes.length > SHOWN_ROUTES ? ` and ${gap.routes.length - SHOWN_ROUTES} more` : ""
      findings.push(
        diagnostic({
          code: "NF-C043",
          severity: "warn",
          ...at,
          message: `merge() adds routes that run none of this server's authentication (${gap.auth.join(", ")}): ${shown}${more}. A merged route keeps the hooks of the server that declared it, and that server authenticates none of its routes.`,
          evidence: [
            "merged routes keep the derive/authenticate/beforeHandle chain of the server that declared them",
            "apply the auth plugin on the merged server, or declare its routes in a group() of this one",
            "a module that is public on purpose: `// nifra-expect NF-C043: <reason>` on the merge line",
          ],
          verify: "nifra check",
        }),
      )
    }
    return findings
  },
}
