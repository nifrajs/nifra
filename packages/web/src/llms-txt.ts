import {
  type ProjectEvidenceSnapshot,
  reflectedRoutesFromEvidence,
  snapshotProjectEvidence,
} from "@nifrajs/core/evidence"
import { type BackendEvidenceProvider, NIFRA_BACKEND_EVIDENCE } from "@nifrajs/core/mount"
import { clientCall, tsTypeOf } from "./internal/client-call.ts"

async function backendEvidence(backend: unknown): Promise<ProjectEvidenceSnapshot> {
  if (backend !== null && (typeof backend === "object" || typeof backend === "function")) {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object/function check allows reading the optional symbol-keyed provider without touching the client path proxy.
    const provider = (backend as { readonly [NIFRA_BACKEND_EVIDENCE]?: unknown })[
      NIFRA_BACKEND_EVIDENCE
    ]
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: A callable at NIFRA_BACKEND_EVIDENCE implements the framework's trusted evidence-provider seam.
    if (typeof provider === "function") return (provider as BackendEvidenceProvider).call(backend)
  }
  return snapshotProjectEvidence(backend)
}

/** Read the project's `AGENTS.md`, or `""` if there isn't one (or we're on an edge runtime with no
 * filesystem). Never throws - a missing file just means no guidelines section. */
async function readAgentsMd(): Promise<string> {
  // Edge bundles define this flag and dead-code-eliminate the filesystem branch. Keeping the import
  // behind a runtime-only `typeof Bun` check is insufficient: Rollup must still emit an unresolved
  // `node:` dependency, which workerd cannot load.
  const edgeRuntime = (
    globalThis as typeof globalThis & { readonly __NIFRA_EDGE_RUNTIME__?: boolean }
  ).__NIFRA_EDGE_RUNTIME__
  if (edgeRuntime === true) return ""
  try {
    if (typeof Bun !== "undefined") return await Bun.file("AGENTS.md").text()
    const fs = await import("node:fs/promises")
    return await fs.readFile("AGENTS.md", "utf-8")
  } catch {
    return ""
  }
}

export async function generateLlmsTxt(
  full: boolean,
  pageRoutes: ReadonlyArray<{ readonly pattern: string; readonly id: string }>,
  backend: unknown,
  options: {
    readonly includeLocalGuidelines?: boolean
    /** Reuse the project's canonical route-evidence pass when one is already available. */
    readonly evidence?: ProjectEvidenceSnapshot
    /** The mount prefix a visitor's URL carries but the backend's own routes do not (`apiStrip`). */
    readonly apiPathPrefix?: string
  } = {},
): Promise<string> {
  let output = ""
  output += `# Nifra App Context\n\n`
  output += `This is a machine-readable context endpoint describing the API routes, pages, and conventions of this Nifra application.\n\n`

  // 1. Project Guidelines. Off unless the app opts in: `AGENTS.md` is a repo file written for the
  //    team, not a page, and this endpoint is public - a note about an unshipped feature or an
  //    internal hostname in it would be served to anyone who asks.
  const agentsMd = options.includeLocalGuidelines === true ? await readAgentsMd() : ""

  if (agentsMd) {
    output += `## Guidelines & Conventions\n\n`
    output += `${agentsMd}\n\n`
  }

  // 2. Page Routes
  output += `## Page Routes\n\n`
  for (const page of pageRoutes) {
    output += `- Page \`${page.pattern}\` (route ID: \`${page.id}\`)\n`
  }
  output += `\n`

  // 3. API Routes
  output += `## API Routes\n\n`
  const apiRoutes = reflectedRoutesFromEvidence(
    options.evidence ?? (await backendEvidence(backend)),
  )

  if (apiRoutes.length === 0) {
    output += `No API routes registered.\n`
  } else {
    const prefix = options.apiPathPrefix ?? ""
    for (const route of apiRoutes) {
      // The stripped backend's root is the bare prefix, as the mount matches it.
      const path = prefix !== "" && route.path === "/" ? prefix : prefix + route.path
      output += `- **${route.method}** \`${path}\`\n`
      if (full) {
        output += `  - Client Call: \`${clientCall(route.method, route.path, route.schema)}\`\n`
        const s = route.schema
        const bodySchema = s?.body?.jsonSchema
        const querySchema = s?.query?.jsonSchema
        const responseSchema = s?.response?.jsonSchema

        if (bodySchema !== undefined) {
          output += `  - Body Schema: \`${tsTypeOf(bodySchema)}\`\n`
        }
        if (querySchema !== undefined) {
          output += `  - Query Schema: \`${tsTypeOf(querySchema)}\`\n`
        }
        if (responseSchema !== undefined) {
          output += `  - Response Schema: \`${tsTypeOf(responseSchema)}\`\n`
        }
        if (s?.errors) {
          for (const status of Object.keys(s.errors)) {
            const errorSchema = s.errors[status]
            if (errorSchema === undefined) continue
            const errJson = errorSchema.jsonSchema
            if (errJson !== undefined) {
              output += `  - Error ${status} Schema: \`${tsTypeOf(errJson)}\`\n`
            }
          }
        }
      }
    }
  }

  return output
}
