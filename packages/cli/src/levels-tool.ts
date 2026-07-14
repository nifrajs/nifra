/**
 * `nifra levels` — the verification ladder, computed from gates that already exist:
 *
 *   L0 typed contract      — `nifra check` passes (compiler-enforced frontend↔backend contract)
 *   L1 route assurance     — `nifra.assurance.ts` present and every route satisfies its policy
 *   L2 capability lockfile — capability/effect assurance passes and the lockfile is in sync
 *   L3 route manifest      — the emitted manifest hash-verifies and matches the current app
 *   L4 invariant-tested    — every route passes through an explicitly isolated executor
 *
 * A level counts only when every level below it holds — the ladder is cumulative, so "L3" is one
 * honest word for a whole posture. Levels are computed, never self-declared.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { evaluateRouteAssurance } from "@nifrajs/core/assurance"
import { type evaluateCapabilityAssurance, snapshotCapabilities } from "@nifrajs/core/capabilities"
import { runContractInvariants } from "@nifrajs/core/invariants"
import { buildNifraManifest, parseNifraManifest } from "@nifrajs/core/manifest"
import { loadAssuranceConfig } from "./assure.ts"
import {
  collectCapabilityProjectReport,
  diffCapabilitySnapshots,
  parseCapabilityLockfile,
} from "./capabilities-tool.ts"
import { collectCheckResult } from "./check.ts"
import { DEFAULT_MANIFEST_FILE } from "./manifest-tool.ts"

export interface VerificationLevelStatus {
  readonly level: number
  readonly name: string
  readonly ok: boolean
  /** Why the level does not hold — a gate failure or a missing prerequisite. Empty when ok. */
  readonly reasons: readonly string[]
}

export interface VerificationLevelsResult {
  /** Highest level whose whole ladder holds; -1 when even L0 fails. */
  readonly achieved: number
  readonly levels: readonly VerificationLevelStatus[]
}

export interface CollectLevelsOptions {
  readonly config?: string
  /** Deterministic seed for the L4 invariant run. Default 1. */
  readonly seed?: number
}

/** Compute the ladder. Each level is evaluated independently, then gated on the levels below. */
export async function collectVerificationLevels(
  cwd: string,
  options: CollectLevelsOptions = {},
): Promise<VerificationLevelsResult> {
  const statuses: { level: number; name: string; ok: boolean; reasons: string[] }[] = []

  // L0 — typed contract (`nifra check`).
  const check = await collectCheckResult(cwd, { maxDiagnostics: 5 })
  statuses.push({
    level: 0,
    name: "typed contract",
    ok: check.ok,
    reasons: check.ok ? [] : check.diagnostics.map((d) => `${d.rule}: ${d.message}`).slice(0, 5),
  })

  // L1-L4 all hang off the assurance config; without it the ladder stops at L0 by definition.
  let config: Awaited<ReturnType<typeof loadAssuranceConfig>> | undefined
  try {
    config = await loadAssuranceConfig(cwd, options.config)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    for (const [level, name] of [
      [1, "route assurance"],
      [2, "capability lockfile"],
      [3, "route manifest"],
      [4, "invariant-tested"],
    ] as const) {
      statuses.push({ level, name, ok: false, reasons: [reason] })
    }
    return finalize(statuses)
  }

  // L1 — route assurance.
  const assurance = evaluateRouteAssurance(config.source, config.policy)
  statuses.push({
    level: 1,
    name: "route assurance",
    ok: assurance.ok,
    reasons: assurance.findings.map((f) => f.message).slice(0, 5),
  })

  // L2 — capability assurance + lockfile in sync.
  const l2Reasons: string[] = []
  let capabilityReport: ReturnType<typeof evaluateCapabilityAssurance> | undefined
  if (config.capabilities === undefined) {
    l2Reasons.push("nifra.assurance.ts declares no capabilities policy")
  } else {
    const project = await collectCapabilityProjectReport(cwd, config.source, config.capabilities)
    capabilityReport = project.report
    if (!project.report.ok) {
      l2Reasons.push(...project.report.findings.map((f) => f.message).slice(0, 5))
    }
    const lockfilePath = resolve(cwd, config.capabilities.lockfile ?? "capabilities.lock.json")
    if (!existsSync(lockfilePath)) {
      l2Reasons.push(`capability lockfile missing (${lockfilePath})`)
    } else if (project.report.ok) {
      const recorded = parseCapabilityLockfile(await Bun.file(lockfilePath).text(), lockfilePath)
      const drift = diffCapabilitySnapshots(recorded, snapshotCapabilities(project.report))
      if (drift.length > 0) l2Reasons.push(...drift.slice(0, 5))
    }
  }
  statuses.push({
    level: 2,
    name: "capability lockfile",
    ok: l2Reasons.length === 0,
    reasons: l2Reasons,
  })

  // L3 — emitted manifest hash-verifies AND matches the current app.
  const l3Reasons: string[] = []
  const manifestPath = resolve(cwd, config.manifest?.path ?? DEFAULT_MANIFEST_FILE)
  if (!existsSync(manifestPath)) {
    l3Reasons.push(`manifest missing (${manifestPath}) — run \`nifra manifest emit\``)
  } else {
    try {
      const recorded = await parseNifraManifest(await Bun.file(manifestPath).text(), manifestPath)
      if (assurance.ok && (capabilityReport === undefined || capabilityReport.ok)) {
        const current = await buildNifraManifest({
          source: config.source,
          assurance,
          ...(capabilityReport !== undefined ? { capabilities: capabilityReport } : {}),
        })
        if (current.contentHash !== recorded.contentHash) {
          l3Reasons.push("manifest is stale — the app changed since it was emitted")
        }
      } else {
        l3Reasons.push("manifest cannot be validated while assurance is failing")
      }
    } catch (err) {
      l3Reasons.push(err instanceof Error ? err.message : String(err))
    }
  }
  statuses.push({
    level: 3,
    name: "route manifest",
    ok: l3Reasons.length === 0,
    reasons: l3Reasons,
  })

  // L4 — contract-generated invariants against an explicitly isolated executor.
  const l4Reasons: string[] = []
  if (config.invariants === undefined) {
    l4Reasons.push(
      "no isolated invariant executor configured — add `invariants.executor` in nifra.assurance.ts",
    )
  } else {
    const invariants = await runContractInvariants(config.source as object, {
      seed: options.seed ?? 1,
      executor: config.invariants.executor,
    })
    if (!invariants.ok) l4Reasons.push(...invariants.findings.map((f) => f.message).slice(0, 5))
    if (invariants.skipped.length > 0) {
      l4Reasons.push(
        ...invariants.skipped
          .slice(0, 5)
          .map(
            (route) => `${route.method} ${route.path} was not invariant-tested: ${route.reason}`,
          ),
      )
    }
  }
  statuses.push({
    level: 4,
    name: "invariant-tested",
    ok: l4Reasons.length === 0,
    reasons: l4Reasons,
  })

  return finalize(statuses)
}

function finalize(
  statuses: readonly { level: number; name: string; ok: boolean; reasons: string[] }[],
): VerificationLevelsResult {
  // Cumulative: the achieved level is the last rung with every rung below it also holding.
  let achieved = -1
  for (const status of statuses) {
    if (!status.ok) break
    achieved = status.level
  }
  return Object.freeze({
    achieved,
    levels: Object.freeze(
      statuses.map((status) =>
        Object.freeze({ ...status, reasons: Object.freeze([...status.reasons]) }),
      ),
    ),
  })
}

/** CLI entry: print the ladder (or JSON) and return whether the requested floor is met. */
export async function runLevels(
  cwd: string,
  options: CollectLevelsOptions & { readonly json?: boolean; readonly min?: number } = {},
): Promise<boolean> {
  const result = await collectVerificationLevels(cwd, options)
  if (options.json === true) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const status of result.levels) {
      const mark = status.ok ? "✓" : "✗"
      console.log(`${mark} L${status.level} ${status.name}`)
      for (const reason of status.reasons) console.log(`    - ${reason}`)
    }
    console.log(
      result.achieved < 0
        ? "[nifra] verification level: none (L0 failing)"
        : `[nifra] verification level: L${result.achieved}`,
    )
  }
  const min = options.min ?? 0
  return result.achieved >= min
}
