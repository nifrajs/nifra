import {
  type FailureDirective,
  type FailureEvidence,
  type FailureReplay,
  type FailureScenario,
  runFailureScenario,
} from "./failure-lab.ts"

/** A named adapter profile composed from the deterministic failure laboratory. */
export interface FaultProfile {
  readonly name: string
  readonly scenarios: readonly FaultProfileScenario[]
}

export interface FaultProfileScenario extends FailureScenario<unknown> {
  readonly id: string
  readonly description: string
}

export interface FaultProfileScenarioReport {
  readonly id: string
  readonly description: string
  readonly ok: boolean
  readonly replay: FailureReplay
  readonly evidence: readonly FailureEvidence[]
  readonly error?: { readonly name: string; readonly kind?: string }
}

export interface FaultProfileReport {
  readonly name: string
  readonly ok: boolean
  readonly scenarios: readonly FaultProfileScenarioReport[]
}

export interface RunFaultProfileOptions {
  readonly seed?: number
  readonly schedule?: readonly FailureDirective[]
}

const PROFILE_NAME = /^[a-z][a-z0-9._-]{0,127}$/

function validateProfile(profile: FaultProfile): FaultProfile {
  if (!PROFILE_NAME.test(profile.name)) {
    throw new TypeError(`fault profile: invalid name ${JSON.stringify(profile.name)}`)
  }
  if (!Array.isArray(profile.scenarios) || profile.scenarios.length === 0) {
    throw new TypeError("fault profile: at least one scenario is required")
  }
  const ids = new Set<string>()
  const scenarios = profile.scenarios.map((scenario) => {
    if (!PROFILE_NAME.test(scenario.id)) {
      throw new TypeError(`fault profile: invalid scenario id ${JSON.stringify(scenario.id)}`)
    }
    if (ids.has(scenario.id)) {
      throw new Error(`fault profile: duplicate scenario id ${JSON.stringify(scenario.id)}`)
    }
    if (scenario.description.trim() === "") {
      throw new Error(`fault profile: scenario ${JSON.stringify(scenario.id)} needs a description`)
    }
    if (typeof scenario.execute !== "function" || typeof scenario.verify !== "function") {
      throw new TypeError(
        `fault profile: scenario ${JSON.stringify(scenario.id)} is not executable`,
      )
    }
    ids.add(scenario.id)
    return Object.freeze({
      ...scenario,
      description: scenario.description.trim(),
    })
  })
  return Object.freeze({
    name: profile.name,
    scenarios: Object.freeze(scenarios),
  })
}

/** Validate and freeze a reusable fault profile. */
export function defineFaultProfile(profile: FaultProfile): FaultProfile {
  return validateProfile(profile)
}

/** Run every profile scenario with the same deterministic seed and failure schedule. */
export async function runFaultProfile(
  profile: FaultProfile,
  options: RunFaultProfileOptions = {},
): Promise<FaultProfileReport> {
  const checked = validateProfile(profile)
  const scenarios: FaultProfileScenarioReport[] = []
  for (const scenario of checked.scenarios) {
    const result = await runFailureScenario(scenario, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      schedule: options.schedule ?? [],
    })
    scenarios.push({
      id: scenario.id,
      description: scenario.description,
      ok: result.ok,
      replay: result.replay,
      evidence: result.evidence,
      ...(result.error === undefined ? {} : { error: result.error }),
    })
  }
  return Object.freeze({
    name: checked.name,
    ok: scenarios.every((scenario) => scenario.ok),
    scenarios: Object.freeze(scenarios),
  })
}

/** A small smoke profile for consumers that only need to verify the harness wiring. */
export const referenceFaultProfile = defineFaultProfile({
  name: "reference",
  scenarios: [
    {
      id: "checkpoint",
      name: "reference-checkpoint",
      description: "the reference adapter reaches a deterministic checkpoint",
      execute(lab) {
        lab.checkpoint("reference.checkpoint")
      },
      verify: () => true,
    },
  ],
})
