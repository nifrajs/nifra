/**
 * One project verification, four commands. `nifra check`, `nifra assure`, `nifra levels`, and
 * `nifra capabilities` are not separate audits - they are renderings of the same reflected project: the
 * typed-contract scan, the route-assurance evaluation, and the static capability provenance. Historically
 * each command re-derived the slice it needed, so a caller had to know which command ran which policy (and
 * `levels` paid for the capability walk twice). `collectProjectVerification` runs each underlying policy
 * exactly once and hands back a single value; the commands become thin formatters over subsets of it -
 * `check`/`assure`/`levels` read their view directly, and `capabilities snapshot`/`check` read the same
 * capability report before writing or diffing the lockfile.
 *
 * The typed-contract check is the one heavy pass (source walk + optional `tsc`), and `nifra assure`
 * never needs it, so it is exposed as a lazily-invoked `check()` rather than computed up front.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import {
  type AssuranceConfig,
  type AssuranceReport,
  evaluateRouteAssurance,
} from "@nifrajs/core/assurance"
import {
  type CapabilityProjectReport,
  collectCapabilityProjectReport,
} from "./capabilities-tool.ts"
import { type CheckAssuranceContext, type CheckResult, collectCheckResult } from "./check.ts"

export interface CollectProjectVerificationOptions {
  /** Assurance config path, default `nifra.assurance.ts`. Honored by the assurance + levels views. */
  readonly config?: string
  /** Skip the `tsc` pass in the check view (the agent inner-loop mode). */
  readonly lintsOnly?: boolean
  /** Cancels the check view's typecheck. */
  readonly signal?: AbortSignal
  /** Cap the check view's diagnostics (the `levels` L0 and MCP paths set this). */
  readonly maxDiagnostics?: number
}

export interface ProjectVerification {
  readonly cwd: string
  /** Whether `nifra.assurance.ts` (or the requested `config` path) exists. */
  readonly assuranceConfigPresent: boolean
  /** The loaded assurance config, when it loaded cleanly. */
  readonly config?: AssuranceConfig
  /** The error from loading/evaluating the config, if any; the assurance views surface or throw it. */
  readonly configError?: unknown
  /** `evaluateRouteAssurance` over the config's source + policy. Present whenever {@link config} is. */
  readonly routeAssurance?: AssuranceReport
  /** Static capability provenance, when the config declares a capabilities policy. */
  readonly capability?: CapabilityProjectReport
  /**
   * The typed-contract check (scanners + typecheck + the assurance-fed capability/manifest diagnostics).
   * Lazy and memoized: `nifra assure` never calls it, so that command pays nothing for the source walk.
   */
  check(): Promise<CheckResult>
}

/**
 * Run each verification policy once and return the unified value. The config is loaded (and reflected)
 * a single time; the resulting route-assurance + capability evidence is both returned for the assurance
 * views and fed into the check view, so nothing is computed twice.
 */
export async function collectProjectVerification(
  cwd: string,
  options: CollectProjectVerificationOptions = {},
): Promise<ProjectVerification> {
  const { loadAssuranceConfig, DEFAULT_ASSURANCE_CONFIG } = await import("./assure.ts")
  const configPath = resolve(cwd, options.config ?? DEFAULT_ASSURANCE_CONFIG)
  const assuranceConfigPresent = existsSync(configPath)

  let config: AssuranceConfig | undefined
  let configError: unknown
  let routeAssurance: AssuranceReport | undefined
  let capability: CapabilityProjectReport | undefined
  // One try mirrors `check`'s single catch: any failure to load or reflect the config becomes the
  // `configError` each view then renders in its own idiom (a diagnostic, a throw, a failed rung).
  try {
    config = await loadAssuranceConfig(cwd, options.config)
    routeAssurance = evaluateRouteAssurance(config.source, config.policy, {
      ...(config.capabilities !== undefined
        ? { definitions: config.capabilities.definitions }
        : {}),
    })
    if (config.capabilities !== undefined) {
      capability = await collectCapabilityProjectReport(cwd, config.source, config.capabilities)
    }
  } catch (error) {
    configError = error
    config = undefined
    routeAssurance = undefined
    capability = undefined
  }

  // The check view's assurance inputs. Fed to `check()` only when no custom config path was requested,
  // so `nifra check` (which always reads the default `nifra.assurance.ts`) and `levels` L0 keep reading
  // exactly the config they read before; a `--config` override stays a route-assurance/levels concern.
  const checkContext: CheckAssuranceContext = {
    present: assuranceConfigPresent,
    ...(config !== undefined ? { config } : {}),
    ...(configError !== undefined ? { error: configError } : {}),
    ...(routeAssurance !== undefined ? { routeAssurance } : {}),
    ...(capability !== undefined ? { capability } : {}),
  }

  let checkResult: Promise<CheckResult> | undefined
  return Object.freeze({
    cwd,
    assuranceConfigPresent,
    ...(config !== undefined ? { config } : {}),
    ...(configError !== undefined ? { configError } : {}),
    ...(routeAssurance !== undefined ? { routeAssurance } : {}),
    ...(capability !== undefined ? { capability } : {}),
    check(): Promise<CheckResult> {
      checkResult ??= collectCheckResult(cwd, {
        lintsOnly: options.lintsOnly ?? false,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.maxDiagnostics !== undefined ? { maxDiagnostics: options.maxDiagnostics } : {}),
        ...(options.config === undefined ? { assurance: checkContext } : {}),
      })
      return checkResult
    },
  })
}
