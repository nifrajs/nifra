import type { StaticRouteFinding } from "../src/check.ts"
import type { ProjectFacts } from "../src/project-facts.ts"
import { sourceIndex } from "../src/rules/index.ts"

export function projectFacts(
  file: string,
  content: string,
  routes: readonly StaticRouteFinding[] = [],
): ProjectFacts {
  const source = sourceIndex([{ file, content }])
  return {
    source,
    routes,
    importGraph: [],
    packages: {
      doctor: {
        ok: true,
        ran: false,
        findings: [],
        duplicateInstalls: [],
        staleDists: [],
      },
      manifestDrift: [],
    },
    policies: {
      checkConfig: { externalMounts: [], rules: {} },
      rulePacks: [],
    },
    sourceFindings: {
      fetches: [],
      untypedClients: [],
      removedImports: [],
      responseRoutes: [],
      interpolatedSql: [],
    },
    legacyDiagnostics: [],
  }
}
