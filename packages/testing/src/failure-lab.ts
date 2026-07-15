/**
 * Deterministic durable-failure laboratory.
 *
 * The controller is an off-hot-path port: tests place named checkpoints around real adapters and a
 * replayable schedule injects crashes, duplicate/reordered delivery, virtual delay, deadline expiry,
 * lost provider replies, or checkpoint contention. Evidence contains tokens only - never payloads,
 * provider results, exception messages, or stacks.
 */

export type FailureKind =
  | "crash"
  | "duplicate-delivery"
  | "reorder-events"
  | "delay"
  | "expire-budget"
  | "lose-provider-reply"
  | "contend-checkpoint"

interface FailureDirectiveBase {
  readonly point: string
  /** 1-based invocation of this kind at this point. Default 1. */
  readonly occurrence?: number
}

export type FailureDirective =
  | (FailureDirectiveBase & { readonly kind: "crash" })
  | (FailureDirectiveBase & {
      readonly kind: "duplicate-delivery"
      /** Total copies of every delivery, including the original. Default 2, maximum 10. */
      readonly copies?: number
    })
  | (FailureDirectiveBase & { readonly kind: "reorder-events" })
  | (FailureDirectiveBase & { readonly kind: "delay"; readonly delayMs: number })
  | (FailureDirectiveBase & { readonly kind: "expire-budget" })
  | (FailureDirectiveBase & { readonly kind: "lose-provider-reply" })
  | (FailureDirectiveBase & { readonly kind: "contend-checkpoint" })

type NormalizedFailureDirective =
  | { readonly kind: "crash"; readonly point: string; readonly occurrence: number }
  | {
      readonly kind: "duplicate-delivery"
      readonly point: string
      readonly occurrence: number
      readonly copies: number
    }
  | { readonly kind: "reorder-events"; readonly point: string; readonly occurrence: number }
  | {
      readonly kind: "delay"
      readonly point: string
      readonly occurrence: number
      readonly delayMs: number
    }
  | { readonly kind: "expire-budget"; readonly point: string; readonly occurrence: number }
  | {
      readonly kind: "lose-provider-reply"
      readonly point: string
      readonly occurrence: number
    }
  | {
      readonly kind: "contend-checkpoint"
      readonly point: string
      readonly occurrence: number
    }

export interface FailureEvidence {
  readonly sequence: number
  readonly kind: FailureKind
  readonly point: string
  readonly occurrence: number
  readonly virtualTimeMs: number
}

export interface FailureReplay {
  readonly seed: number
  readonly schedule: readonly NormalizedFailureDirective[]
}

export interface FailureLabOptions {
  /** Replayable unsigned seed. Default is stable. */
  readonly seed?: number
  readonly schedule: readonly FailureDirective[]
  /** Virtual epoch/monotonic start. No real sleep is ever performed. Default 0. */
  readonly startTimeMs?: number
}

export interface FailureLab {
  /** Apply virtual delay and/or crash directives at a named durability seam. */
  checkpoint(point: string): void
  /** Apply duplicate/reorder directives to a delivery batch without inspecting its values. */
  deliveries<T>(point: string, values: readonly T[]): readonly T[]
  /** Run the provider operation, then optionally lose only its reply. */
  provider<T>(point: string, operation: () => T | Promise<T>): Promise<T>
  /** Return zero when this budget seam is scheduled to expire; otherwise clamp the supplied value. */
  remaining(point: string, remainingMs: number): number
  /** True only for a scheduled checkpoint conflict occurrence. */
  checkpointContended(point: string): boolean
  /** Current virtual time. */
  now(): number
  /** Immutable, token-only injection evidence. */
  evidence(): readonly FailureEvidence[]
  /** Exact normalized replay inputs. */
  replay(): FailureReplay
}

export class FailureInjectedError extends Error {
  override readonly name = "FailureInjectedError"

  constructor(
    readonly kind: "crash" | "lose-provider-reply",
    readonly point: string,
    readonly occurrence: number,
  ) {
    super(`failure laboratory injected ${kind} at ${point}#${occurrence}`)
  }
}

export interface FailureScenario<Output> {
  readonly name: string
  execute(lab: FailureLab): Output | Promise<Output>
  /** The scenario passes only when this post-failure invariant returns true. */
  verify(context: {
    readonly lab: FailureLab
    readonly result?: Output
    readonly error?: unknown
  }): boolean | Promise<boolean>
}

export interface FailureScenarioReport {
  readonly name: string
  readonly ok: boolean
  readonly replay: FailureReplay
  readonly evidence: readonly FailureEvidence[]
  /** Sanitized failure identity. Messages and stacks are deliberately excluded. */
  readonly error?: {
    readonly name: string
    readonly kind?: FailureInjectedError["kind"]
  }
}

const DEFAULT_SEED = 0x46_41_49_4c
const MAX_DIRECTIVES = 128
const MAX_OCCURRENCE = 10_000
const MAX_COPIES = 10
const MAX_DELAY_MS = 24 * 60 * 60_000
const POINT = /^[a-z][a-z0-9._:-]{0,127}$/
const SCENARIO = /^[a-z][a-z0-9._-]{0,127}$/

const integerIn = (value: number, min: number, max: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`failure laboratory: ${label} must be an integer from ${min} to ${max}`)
  }
  return value
}

const pointOf = (value: string): string => {
  if (!POINT.test(value)) {
    throw new TypeError(`failure laboratory: invalid failure point ${JSON.stringify(value)}`)
  }
  return value
}

const normalizeSeed = (seed: number | undefined): number =>
  Number.isFinite(seed) ? Math.trunc(seed as number) >>> 0 : DEFAULT_SEED

const hash = (value: string): number => {
  let result = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16_777_619)
  }
  return result >>> 0
}

function normalizeSchedule(
  schedule: readonly FailureDirective[],
): readonly NormalizedFailureDirective[] {
  if (!Array.isArray(schedule) || schedule.length > MAX_DIRECTIVES) {
    throw new RangeError(`failure laboratory: schedule cannot exceed ${MAX_DIRECTIVES} directives`)
  }
  const seen = new Set<string>()
  return Object.freeze(
    schedule.map((directive) => {
      const point = pointOf(directive.point)
      const occurrence = integerIn(directive.occurrence ?? 1, 1, MAX_OCCURRENCE, "occurrence")
      const identity = `${directive.kind}\n${point}\n${occurrence}`
      if (seen.has(identity)) {
        throw new Error(
          `failure laboratory: duplicate directive ${directive.kind} at ${point}#${occurrence}`,
        )
      }
      seen.add(identity)
      if (directive.kind === "duplicate-delivery") {
        return Object.freeze({
          kind: directive.kind,
          point,
          occurrence,
          copies: integerIn(directive.copies ?? 2, 2, MAX_COPIES, "copies"),
        })
      }
      if (directive.kind === "delay") {
        return Object.freeze({
          kind: directive.kind,
          point,
          occurrence,
          delayMs: integerIn(directive.delayMs, 1, MAX_DELAY_MS, "delayMs"),
        })
      }
      return Object.freeze({ kind: directive.kind, point, occurrence })
    }),
  )
}

/** Build one isolated deterministic controller. Construct a fresh lab for every replay. */
export function createFailureLab(options: FailureLabOptions): FailureLab {
  const seed = normalizeSeed(options.seed)
  const schedule = normalizeSchedule(options.schedule)
  let virtualTimeMs = options.startTimeMs ?? 0
  if (!Number.isSafeInteger(virtualTimeMs) || virtualTimeMs < 0) {
    throw new RangeError("failure laboratory: startTimeMs must be a non-negative safe integer")
  }
  const counts = new Map<string, number>()
  const emitted: FailureEvidence[] = []
  let sequence = 0

  const directives = (
    point: string,
    kinds: readonly FailureKind[],
  ): readonly NormalizedFailureDirective[] => {
    pointOf(point)
    const occurrences = new Map<FailureKind, number>()
    for (const kind of kinds) {
      const key = `${kind}\n${point}`
      const occurrence = (counts.get(key) ?? 0) + 1
      counts.set(key, occurrence)
      occurrences.set(kind, occurrence)
    }
    return schedule.filter(
      (directive) =>
        directive.point === point && occurrences.get(directive.kind) === directive.occurrence,
    )
  }

  const emit = (directive: NormalizedFailureDirective): void => {
    emitted.push(
      Object.freeze({
        sequence: ++sequence,
        kind: directive.kind,
        point: directive.point,
        occurrence: directive.occurrence,
        virtualTimeMs,
      }),
    )
  }

  const lab: FailureLab = {
    checkpoint(point) {
      for (const directive of directives(point, ["delay", "crash"])) {
        if (directive.kind === "delay") virtualTimeMs += directive.delayMs
        emit(directive)
        if (directive.kind === "crash") {
          throw new FailureInjectedError("crash", point, directive.occurrence)
        }
      }
    },

    deliveries<T>(point: string, values: readonly T[]): readonly T[] {
      let output = [...values]
      for (const directive of directives(point, ["duplicate-delivery", "reorder-events"])) {
        if (directive.kind === "duplicate-delivery") {
          output = output.flatMap((value) => Array.from({ length: directive.copies }, () => value))
        } else if (directive.kind === "reorder-events" && output.length > 1) {
          const offset =
            1 + (hash(`${seed}:${point}:${directive.occurrence}`) % (output.length - 1))
          output = [...output.slice(offset), ...output.slice(0, offset)]
        }
        emit(directive)
      }
      return Object.freeze(output)
    },

    async provider<T>(point: string, operation: () => T | Promise<T>): Promise<T> {
      pointOf(point)
      const result = await operation()
      for (const directive of directives(point, ["lose-provider-reply"])) {
        emit(directive)
        throw new FailureInjectedError("lose-provider-reply", point, directive.occurrence)
      }
      return result
    },

    remaining(point, remainingMs) {
      if (!Number.isFinite(remainingMs)) {
        throw new TypeError("failure laboratory: remainingMs must be finite")
      }
      const remaining = Math.max(0, remainingMs)
      const injected = directives(point, ["expire-budget"])
      for (const directive of injected) emit(directive)
      return injected.length > 0 ? 0 : remaining
    },

    checkpointContended(point) {
      const injected = directives(point, ["contend-checkpoint"])
      for (const directive of injected) emit(directive)
      return injected.length > 0
    },

    now: () => virtualTimeMs,
    evidence: () => Object.freeze([...emitted]),
    replay: () => Object.freeze({ seed, schedule }),
  }
  return Object.freeze(lab)
}

/** Run one scenario and evaluate its post-failure invariant without leaking its result or error text. */
export async function runFailureScenario<Output>(
  scenario: FailureScenario<Output>,
  options: FailureLabOptions,
): Promise<FailureScenarioReport> {
  if (!SCENARIO.test(scenario.name)) {
    throw new TypeError(
      `failure laboratory: invalid scenario name ${JSON.stringify(scenario.name)}`,
    )
  }
  const lab = createFailureLab(options)
  let result: Output | undefined
  let error: unknown
  try {
    result = await scenario.execute(lab)
  } catch (caught) {
    error = caught
  }
  let ok = false
  try {
    ok =
      (await scenario.verify({
        lab,
        ...(error === undefined ? { result: result as Output } : { error }),
      })) === true
  } catch {
    ok = false
  }
  const errorSummary =
    error === undefined
      ? undefined
      : Object.freeze({
          name: error instanceof Error ? error.name : "NonErrorThrown",
          ...(error instanceof FailureInjectedError ? { kind: error.kind } : {}),
        })
  return Object.freeze({
    name: scenario.name,
    ok,
    replay: lab.replay(),
    evidence: lab.evidence(),
    ...(errorSummary === undefined ? {} : { error: errorSummary }),
  })
}
