import type { CapabilityProjectReport } from "./capabilities-tool.ts"
import type {
  CheckAssuranceContext,
  CheckConfig,
  CheckTypecheckResult,
} from "./check-diagnostics.ts"
import type {
  ManifestDriftFinding,
  SourceFinding,
  StaticRouteFinding,
  TransitiveServerImportFinding,
} from "./check-scan.ts"
import type { DoctorResult } from "./doctor.ts"
import type { PipelineReport } from "./pipeline-report.ts"
import type { RulePack, SourceIndex } from "./rules/index.ts"

export interface ProjectSourceFindings {
  readonly fetches: readonly SourceFinding[]
  /** Hand-rolled `new EventSource("/…")` / `new WebSocket("/…")` to the app's own streaming surface. */
  readonly streams: readonly SourceFinding[]
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

export interface ContractCheckFacts {
  readonly present: boolean
  readonly vacuous: boolean
  readonly diagnostics: readonly { readonly route?: string; readonly message: string }[]
  readonly error?: string
}

/** Check-wide inputs that rules format into diagnostics. Scanners populate facts; rules own policy. */
export interface ProjectCheckFacts {
  readonly typecheck: CheckTypecheckResult
  readonly sqlCompilerAvailable: boolean
  readonly checkConfigError?: string
  readonly checkConfigWarnings: readonly string[]
  readonly contracts: ContractCheckFacts
}

export interface ProjectFacts {
  readonly source: SourceIndex
  readonly routes: readonly StaticRouteFinding[]
  readonly importGraph: readonly TransitiveServerImportFinding[]
  readonly packages: ProjectPackageFacts
  readonly pipeline?: PipelineReport
  readonly policies: ProjectPolicyFacts
  readonly check: ProjectCheckFacts
  readonly sourceFindings: ProjectSourceFindings
}

export type ProjectFactsSeed = ProjectFacts

function freezeFindings<T extends object>(findings: readonly T[]): readonly T[] {
  return Object.freeze(findings.map((finding) => Object.freeze({ ...finding })))
}

/**
 * Publish the one immutable rule snapshot. The loader owns all mutable scan buffers; rules only see
 * these copied, frozen collections. Policy/config objects remain caller-owned because assurance config
 * can contain executable adapters and must not be frozen as a side effect of checking.
 */
export function freezeProjectFacts(seed: ProjectFactsSeed): ProjectFacts {
  const sourceFindings: ProjectSourceFindings = Object.freeze({
    fetches: freezeFindings(seed.sourceFindings.fetches),
    streams: freezeFindings(seed.sourceFindings.streams),
    untypedClients: freezeFindings(seed.sourceFindings.untypedClients),
    removedImports: freezeFindings(seed.sourceFindings.removedImports),
    responseRoutes: freezeFindings(seed.sourceFindings.responseRoutes),
    interpolatedSql: freezeFindings(seed.sourceFindings.interpolatedSql),
  })
  const policies = Object.freeze({
    ...seed.policies,
    rulePacks: Object.freeze([...seed.policies.rulePacks]),
  })
  const check = Object.freeze({
    ...seed.check,
    typecheck: Object.freeze({ ...seed.check.typecheck }),
    checkConfigWarnings: Object.freeze([...seed.check.checkConfigWarnings]),
    contracts: Object.freeze({
      ...seed.check.contracts,
      diagnostics: freezeFindings(seed.check.contracts.diagnostics),
    }),
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
    check,
    sourceFindings,
  })
}
