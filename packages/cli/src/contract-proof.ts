import { existsSync, realpathSync } from "node:fs"
import { resolve, sep } from "node:path"
import type { AssuranceFinding, AssuranceReport, AssuredRoute } from "@nifrajs/core/assurance"
import type {
  AssuredCapabilityRoute,
  CapabilityAssuranceReport,
  CapabilityFinding,
} from "@nifrajs/core/capabilities"
import { diffRouteSnapshots, type RouteChange, type RoutesDiff } from "@nifrajs/core/diff"
import type { CheckResult } from "./check.ts"
import { DEFAULT_SNAPSHOT_FILE, parseSnapshotFile, snapshotBackend } from "./diff-tool.ts"
import { collectProjectVerification } from "./verification.ts"

const routeKey = (method: string, path: string): string => `${method.toUpperCase()}\n${path}`

export interface ContractProofRoute {
  readonly method: string
  readonly path: string
  readonly changes: readonly RouteChange[]
  readonly assurance?: {
    readonly route?: AssuredRoute
    readonly findings: readonly AssuranceFinding[]
  }
  readonly capability?: {
    readonly route?: AssuredCapabilityRoute
    readonly findings: readonly CapabilityFinding[]
  }
}

export interface ContractProofVerification {
  readonly assuranceConfigPresent: boolean
  readonly configError?: string
  readonly assurance?: {
    readonly ok: boolean
    readonly routeCount: number
    readonly findings: readonly AssuranceFinding[]
  }
  readonly capability?: {
    readonly ok: boolean
    readonly routeCount: number
    readonly findings: readonly CapabilityFinding[]
  }
  readonly check?: CheckResult
}

export interface ContractProofReport {
  readonly baseline: string
  readonly hasBreaking: boolean
  readonly changes: readonly RouteChange[]
  readonly routes: readonly ContractProofRoute[]
  readonly verification: ContractProofVerification
}

export interface ContractProofOptions {
  /** Baseline path relative to the project directory. Defaults to api-snapshot.json. */
  readonly baselinePath?: string
  /** Run the lazy typed-contract check only when explicitly requested. */
  readonly check?: boolean
  readonly signal?: AbortSignal
}

function safeBaselinePath(cwd: string, baselinePath: string): string {
  const root = resolve(cwd)
  const target = resolve(root, baselinePath)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error("contract proof baseline must stay inside the project directory")
  }
  return target
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function changedRoutes(
  diff: RoutesDiff,
  assurance: AssuranceReport | undefined,
  capability: CapabilityAssuranceReport | undefined,
): readonly ContractProofRoute[] {
  const changes = new Map<string, RouteChange[]>()
  for (const change of diff.changes) {
    const key = routeKey(change.method, change.path)
    const current = changes.get(key)
    if (current === undefined) changes.set(key, [change])
    else current.push(change)
  }

  const assured = new Map(
    (assurance?.routes ?? []).map((route) => [routeKey(route.method, route.path), route]),
  )
  const assuranceFindings = new Map<string, AssuranceFinding[]>()
  for (const finding of assurance?.findings ?? []) {
    const key = routeKey(finding.method, finding.path)
    const current = assuranceFindings.get(key)
    if (current === undefined) assuranceFindings.set(key, [finding])
    else current.push(finding)
  }

  const capable = new Map(
    (capability?.routes ?? []).map((route) => [routeKey(route.method, route.path), route]),
  )
  const capabilityFindings = new Map<string, CapabilityFinding[]>()
  for (const finding of capability?.findings ?? []) {
    const key = routeKey(finding.method, finding.path)
    const current = capabilityFindings.get(key)
    if (current === undefined) capabilityFindings.set(key, [finding])
    else current.push(finding)
  }

  return Object.freeze(
    [...changes].map(([key, routeChanges]) => {
      const first = routeChanges[0]
      if (first === undefined) throw new Error("contract proof: missing route change")
      const assuredRoute = assured.get(key)
      const capableRoute = capable.get(key)
      return {
        method: first.method,
        path: first.path,
        changes: Object.freeze([...routeChanges]),
        ...(assurance === undefined
          ? {}
          : {
              assurance: {
                ...(assuredRoute === undefined ? {} : { route: assuredRoute }),
                findings: Object.freeze([...(assuranceFindings.get(key) ?? [])]),
              },
            }),
        ...(capability === undefined
          ? {}
          : {
              capability: {
                ...(capableRoute === undefined ? {} : { route: capableRoute }),
                findings: Object.freeze([...(capabilityFindings.get(key) ?? [])]),
              },
            }),
      }
    }),
  )
}

/** Compose route diff, route assurance, capability evidence, and an optional check result. */
export async function collectContractProof(
  cwd: string,
  options: ContractProofOptions = {},
): Promise<ContractProofReport> {
  const baselinePath = options.baselinePath ?? DEFAULT_SNAPSHOT_FILE
  const resolvedBaseline = safeBaselinePath(cwd, baselinePath)
  if (!existsSync(resolvedBaseline)) {
    throw new Error(`contract proof baseline not found: ${resolvedBaseline}`)
  }
  const realRoot = realpathSync(resolve(cwd))
  const realBaseline = realpathSync(resolvedBaseline)
  if (realBaseline !== realRoot && !realBaseline.startsWith(`${realRoot}${sep}`)) {
    throw new Error("contract proof baseline must stay inside the project directory")
  }
  const baseline = parseSnapshotFile(await Bun.file(resolvedBaseline).text(), baselinePath)
  const current = await snapshotBackend(cwd)
  const diff = diffRouteSnapshots(baseline.routes, current)
  const verification = await collectProjectVerification(cwd, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const proof: ContractProofVerification = {
    assuranceConfigPresent: verification.assuranceConfigPresent,
    ...(verification.configError === undefined
      ? {}
      : { configError: errorMessage(verification.configError) }),
    ...(verification.routeAssurance === undefined
      ? {}
      : {
          assurance: {
            ok: verification.routeAssurance.ok,
            routeCount: verification.routeAssurance.routes.length,
            findings: verification.routeAssurance.findings,
          },
        }),
    ...(verification.capability === undefined
      ? {}
      : {
          capability: {
            ok: verification.capability.report.ok,
            routeCount: verification.capability.report.routes.length,
            findings: verification.capability.report.findings,
          },
        }),
    ...(options.check === true ? { check: await verification.check() } : {}),
  }
  return Object.freeze({
    baseline: baselinePath,
    hasBreaking: diff.hasBreaking,
    changes: diff.changes,
    routes: changedRoutes(diff, verification.routeAssurance, verification.capability?.report),
    verification: proof,
  })
}
