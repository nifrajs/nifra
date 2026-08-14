import type { CapabilityProjectReport } from "./capabilities-tool.ts"
import type {
  CheckAssuranceContext,
  CheckConfig,
  CheckDiagnostic,
  ManifestDriftFinding,
  SourceFinding,
  StaticRouteFinding,
  TransitiveServerImportFinding,
} from "./check.ts"
import type { DoctorResult } from "./doctor.ts"
import type { PipelineReport } from "./pipeline-report.ts"
import type { RulePack, SourceIndex } from "./rules/index.ts"

export interface ProjectSourceFindings {
  readonly fetches: readonly SourceFinding[]
  readonly untypedClients: readonly SourceFinding[]
  readonly removedImports: readonly SourceFinding[]
  readonly responseRoutes: readonly SourceFinding[]
  readonly interpolatedSql: readonly SourceFinding[]
}

export interface ProjectPackageFacts {
  readonly doctor: DoctorResult
  readonly manifestDrift: readonly ManifestDriftFinding[]
}

export interface ProjectPolicyFacts {
  readonly assurance?: CheckAssuranceContext
  readonly capability?: CapabilityProjectReport
  readonly checkConfig: CheckConfig
  readonly rulePacks: readonly RulePack[]
}

export interface ProjectFacts {
  readonly source: SourceIndex
  readonly routes: readonly StaticRouteFinding[]
  readonly importGraph: readonly TransitiveServerImportFinding[]
  readonly packages: ProjectPackageFacts
  readonly pipeline?: PipelineReport
  readonly policies: ProjectPolicyFacts
  readonly sourceFindings: ProjectSourceFindings
  readonly legacyDiagnostics: readonly CheckDiagnostic[]
}

export type ProjectFactsSeed = Omit<ProjectFacts, "legacyDiagnostics">

function freezeFindings<T extends object>(findings: readonly T[]): readonly T[] {
  return Object.freeze(findings.map((finding) => Object.freeze({ ...finding })))
}

/**
 * Publish the one immutable rule snapshot. The loader owns all mutable scan buffers; rules only see
 * these copied, frozen collections. Policy/config objects remain caller-owned because assurance config
 * can contain executable adapters and must not be frozen as a side effect of checking.
 */
export function freezeProjectFacts(
  seed: ProjectFactsSeed,
  legacyDiagnostics: readonly CheckDiagnostic[],
): ProjectFacts {
  const sourceFindings: ProjectSourceFindings = Object.freeze({
    fetches: freezeFindings(seed.sourceFindings.fetches),
    untypedClients: freezeFindings(seed.sourceFindings.untypedClients),
    removedImports: freezeFindings(seed.sourceFindings.removedImports),
    responseRoutes: freezeFindings(seed.sourceFindings.responseRoutes),
    interpolatedSql: freezeFindings(seed.sourceFindings.interpolatedSql),
  })
  const policies = Object.freeze({
    ...seed.policies,
    rulePacks: Object.freeze([...seed.policies.rulePacks]),
  })
  return Object.freeze({
    ...seed,
    source: Object.freeze(seed.source),
    routes: freezeFindings(seed.routes),
    importGraph: freezeFindings(seed.importGraph),
    packages: Object.freeze({
      doctor: seed.packages.doctor,
      manifestDrift: freezeFindings(seed.packages.manifestDrift),
    }),
    ...(seed.pipeline === undefined ? {} : { pipeline: Object.freeze(seed.pipeline) }),
    policies,
    sourceFindings,
    legacyDiagnostics: freezeFindings(legacyDiagnostics),
  })
}
