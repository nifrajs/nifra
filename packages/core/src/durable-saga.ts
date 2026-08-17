import type { EffectLifecycleObserver } from "./effect-lifecycle.ts"
import { createEffectScope } from "./effect-scope.ts"
import { validCapabilityId } from "./internal/capability-runtime.ts"
import { durableSagaProtocol } from "./internal/durable-saga-protocol.ts"
import {
  addDuration,
  assertPositiveMs,
  assertTimestamp,
  assertToken,
  bucketAdd,
  bucketMove,
  cloneValue,
  ERROR_CODE,
  indexedScan,
  MAX_RECONCILIATION_LIMIT,
  memoryScan,
  readClock,
  reconciliationLimit,
} from "./internal/durable-shared.ts"
import type {
  ReconciliationPage,
  ReconciliationScanOptions,
  ReconciliationScanPage,
  SagaDefinition,
  SagaRecord,
  SagaRunContext,
  SagaState,
  SagaStepRecord,
  SagaStore,
} from "./internal/durable-types.ts"

// Durable saga + compensation state machine

function assertSagaDefinition<I, C extends Record<string, unknown>>(
  definition: SagaDefinition<I, C>,
): void {
  if (typeof definition !== "object" || definition === null)
    throw new TypeError("saga definition must be an object")
  assertToken(definition.name, "saga definition", 128)
  if (definition.capability !== undefined && !validCapabilityId(definition.capability))
    throw new TypeError("saga capability is invalid")
  if (typeof definition.run !== "function") throw new TypeError("saga run must be a function")
  if (
    typeof definition.compensators !== "object" ||
    definition.compensators === null ||
    Array.isArray(definition.compensators)
  ) {
    throw new TypeError("saga compensators must be an object")
  }
  for (const [name, compensator] of Object.entries(definition.compensators)) {
    assertToken(name, "saga compensator name", 128)
    if (typeof compensator !== "function")
      throw new TypeError(`saga compensator ${name} must be a function`)
  }
  if (definition.retry !== undefined) {
    if (typeof definition.retry !== "object" || definition.retry === null)
      throw new TypeError("saga retry must be an object")
    if (definition.retry.maxAttempts !== undefined)
      assertPositiveMs(definition.retry.maxAttempts, "saga maxAttempts")
    if (
      definition.retry.backoffMs !== undefined &&
      typeof definition.retry.backoffMs !== "function"
    )
      throw new TypeError("saga backoffMs must be a function")
  }
}

export function defineSaga<I, C extends Record<string, unknown>>(
  definition: SagaDefinition<I, C>,
): SagaDefinition<I, C> {
  assertSagaDefinition(definition)
  return Object.freeze({
    ...definition,
    compensators: Object.freeze({ ...definition.compensators }),
    ...(definition.retry === undefined ? {} : { retry: Object.freeze({ ...definition.retry }) }),
  })
}

export class SagaConcurrencyError extends Error {
  constructor(public readonly sagaId: string) {
    super(`saga ${sagaId}: concurrent transition rejected`)
    this.name = "SagaConcurrencyError"
  }
}
export class SagaAmbiguousStepError extends Error {
  constructor(
    public readonly sagaId: string,
    public readonly step: string,
    public readonly effectId: string,
  ) {
    super(`saga ${sagaId}: step ${step} has an ambiguous effect`)
    this.name = "SagaAmbiguousStepError"
  }
}

export class SagaResolutionError extends Error {
  constructor(
    public readonly sagaId: string,
    public readonly step: string,
    message: string,
  ) {
    super(`saga ${sagaId}: step ${step} ${message}`)
    this.name = "SagaResolutionError"
  }
}
/** Throw this only when a provider conclusively proves that no effect committed. */
export class SagaStepNotCommittedError extends Error {
  constructor(public readonly code = "not_committed") {
    super("saga step conclusively did not commit")
    this.name = "SagaStepNotCommittedError"
    if (!ERROR_CODE.test(code)) throw new TypeError("saga step error code is invalid")
  }
}

export interface SagaEngineOptions {
  readonly store: SagaStore
  readonly now?: () => number
  readonly observer?: EffectLifecycleObserver
  /** Tests/local development only. Production sagas require a durable store. */
  readonly allowMemoryStore?: boolean
}

export type SagaAmbiguityResolution =
  | {
      readonly kind: "execution"
      readonly step: string
      readonly effectId: string
      readonly outcome: "committed"
      /** Provider-confirmed result required by later saga steps. */
      readonly result: unknown
    }
  | {
      readonly kind: "execution"
      readonly step: string
      readonly effectId: string
      readonly outcome: "not-committed"
      readonly errorCode?: string
    }
  | {
      readonly kind: "compensation"
      readonly step: string
      readonly effectId: string
      readonly outcome: "compensated" | "not-compensated"
    }

export interface SagaEngine {
  execute<I, C extends Record<string, unknown>>(
    definition: SagaDefinition<I, C>,
    sagaId: string,
    input: I,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SagaRecord>
  resume<I, C extends Record<string, unknown>>(
    definition: SagaDefinition<I, C>,
    sagaId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SagaRecord>
  compensate<I, C extends Record<string, unknown>>(
    definition: SagaDefinition<I, C>,
    sagaId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SagaRecord>
  /**
   * Apply a provider/operator-confirmed outcome to an ambiguous durable transition. The supplied
   * effect id must match the stored execution/compensation id, preventing a stale review from
   * resolving a later operation. The caller remains responsible for authenticating and authorizing
   * the operator. Call `resume` or `compensate` after the resolution.
   */
  resolveAmbiguity<I, C extends Record<string, unknown>>(
    definition: SagaDefinition<I, C>,
    sagaId: string,
    resolution: SagaAmbiguityResolution,
  ): Promise<SagaRecord>
}

let neverAbortSignal: AbortSignal | undefined
function signalOrNever(signal?: AbortSignal): AbortSignal {
  neverAbortSignal ??= new AbortController().signal
  return signal ?? neverAbortSignal
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("saga execution aborted")
  }
}

export function createSagaEngine(options: SagaEngineOptions): SagaEngine {
  if (options.store.durability !== "durable" && options.allowMemoryStore !== true)
    throw new TypeError('saga engine requires store.durability === "durable"')
  const clock = options.now ?? Date.now
  const now = (): number => readClock(clock, "saga clock")
  const observer = options.observer

  const load = async (sagaId: string): Promise<SagaRecord> => {
    const record = await options.store.get(sagaId)
    if (record === undefined) throw new Error(`saga ${sagaId}: not found`)
    if (
      record.sagaId !== sagaId ||
      !["running", "compensating", "completed", "compensated", "manual-review"].includes(
        record.state,
      ) ||
      !Array.isArray(record.steps) ||
      !Number.isSafeInteger(record.version) ||
      record.version < 1
    ) {
      throw new TypeError(`saga ${sagaId}: store returned an invalid record`)
    }
    assertToken(record.definition, "stored saga definition", 128)
    assertTimestamp(record.createdAt, "stored saga createdAt")
    assertTimestamp(record.updatedAt, "stored saga updatedAt")
    if (record.createdAt > record.updatedAt)
      throw new TypeError(`saga ${sagaId}: updatedAt precedes createdAt`)
    const names = new Set<string>()
    const effectIds = new Set<string>()
    for (const step of record.steps) {
      assertToken(step.name, "stored saga step", 128)
      assertToken(step.effectId, "stored saga effect id", 64)
      assertToken(step.compensationEffectId, "stored saga compensation effect id", 64)
      if (
        ![
          "executing",
          "committed",
          "failed",
          "ambiguous",
          "compensating",
          "compensation-failed",
          "compensated",
        ].includes(step.state) ||
        !Number.isSafeInteger(step.attempts) ||
        step.attempts < 0 ||
        names.has(step.name) ||
        effectIds.has(step.effectId) ||
        effectIds.has(step.compensationEffectId)
      ) {
        throw new TypeError(`saga ${sagaId}: store returned an invalid step record`)
      }
      names.add(step.name)
      effectIds.add(step.effectId)
      effectIds.add(step.compensationEffectId)
      if (step.nextAttemptAt !== undefined)
        assertTimestamp(step.nextAttemptAt, "stored saga nextAttemptAt")
      if (step.errorCode !== undefined && !ERROR_CODE.test(step.errorCode))
        throw new TypeError(`saga ${sagaId}: store returned an invalid error code`)
    }
    return record
  }
  const save = async (
    current: SagaRecord,
    update: Omit<SagaRecord, "version">,
  ): Promise<SagaRecord> => {
    const next = durableSagaProtocol.transition(current, {
      sagaId: current.sagaId,
      version: current.version,
      record: Object.freeze({ ...update, version: current.version + 1 }),
    })
    if (next === undefined) throw new SagaConcurrencyError(current.sagaId)
    if (
      !(await options.store.compareAndSet({
        sagaId: current.sagaId,
        version: current.version,
        record: next,
      }))
    )
      throw new SagaConcurrencyError(current.sagaId)
    return next
  }
  const withStep = (
    record: SagaRecord,
    index: number,
    step: SagaStepRecord,
    state = record.state,
  ): Omit<SagaRecord, "version"> => durableSagaProtocol.withStep(record, index, step, state, now())
  const effectScope = createEffectScope({
    ...(observer === undefined ? {} : { observers: [observer] }),
  })

  const compensate = async <I, C extends Record<string, unknown>>(
    definition: SagaDefinition<I, C>,
    sagaId: string,
    runOptions: { readonly signal?: AbortSignal } = {},
  ): Promise<SagaRecord> => {
    assertSagaDefinition(definition)
    assertToken(sagaId, "saga id", 128)
    const signal = signalOrNever(runOptions.signal)
    throwIfAborted(signal)
    let record = await load(sagaId)
    if (record.definition !== definition.name) throw new TypeError("saga definition mismatch")
    if (record.state === "completed" || record.state === "compensated") return record
    if (
      record.steps.some(
        (step) =>
          step.state === "ambiguous" || step.state === "executing" || step.state === "compensating",
      )
    ) {
      if (record.state !== "manual-review")
        record = await save(record, { ...record, state: "manual-review", updatedAt: now() })
      const ambiguous = record.steps.find(
        (step) =>
          step.state === "ambiguous" || step.state === "executing" || step.state === "compensating",
      ) as SagaStepRecord
      throw new SagaAmbiguousStepError(
        sagaId,
        ambiguous.name,
        ambiguous.state === "compensating" ? ambiguous.compensationEffectId : ambiguous.effectId,
      )
    }
    if (record.state !== "compensating")
      record = await save(record, { ...record, state: "compensating", updatedAt: now() })
    const maxAttempts = definition.retry?.maxAttempts ?? 3
    assertPositiveMs(maxAttempts, "saga maxAttempts")
    const backoff =
      definition.retry?.backoffMs ??
      ((attempt: number) => Math.min(60_000, 100 * 2 ** (attempt - 1)))

    for (let index = record.steps.length - 1; index >= 0; index--) {
      throwIfAborted(signal)
      let step = record.steps[index] as SagaStepRecord
      if (step.state === "compensated" || step.state === "failed") continue
      if (step.state !== "committed" && step.state !== "compensation-failed") continue
      if (step.nextAttemptAt !== undefined && step.nextAttemptAt > now()) return record
      const compensator = definition.compensators[step.name as keyof C]
      if (typeof compensator !== "function") {
        record = await save(record, { ...record, state: "manual-review", updatedAt: now() })
        return record
      }
      if (step.attempts >= maxAttempts) {
        if (record.state !== "manual-review")
          record = await save(record, { ...record, state: "manual-review", updatedAt: now() })
        return record
      }
      const attempt = step.attempts + 1
      const { errorCode: _errorCode, nextAttemptAt: _nextAttemptAt, ...stepBase } = step
      step = { ...stepBase, state: "compensating", attempts: attempt }
      let transitionError: unknown
      try {
        await effectScope.run(
          {
            effectId: step.compensationEffectId,
            capability: definition.capability ?? "saga.compensate",
            stage: "compensation",
            signal,
            attempt,
            failurePhase: () => "failed",
            errorCode: () => "compensation_failed",
            transitions: {
              async executing() {
                record = await save(record, withStep(record, index, step))
              },
              async committed() {
                step = { ...step, state: "compensated" }
                record = await save(record, withStep(record, index, step))
              },
              async failed() {
                const exhausted = attempt >= maxAttempts
                try {
                  const delay = exhausted ? undefined : backoff(attempt)
                  if (delay !== undefined && (!Number.isSafeInteger(delay) || delay < 0))
                    throw new RangeError("saga backoff must return a non-negative safe integer")
                  const failed: SagaStepRecord = {
                    ...step,
                    state: "compensation-failed",
                    errorCode: "compensation_failed",
                    ...(delay === undefined
                      ? {}
                      : { nextAttemptAt: addDuration(now(), delay, "saga next retry") }),
                  }
                  record = await save(
                    record,
                    withStep(record, index, failed, exhausted ? "manual-review" : "compensating"),
                  )
                } catch (error) {
                  transitionError = error
                  const failed: SagaStepRecord = {
                    ...step,
                    state: "compensation-failed",
                    errorCode: "invalid_retry_policy",
                  }
                  record = await save(record, withStep(record, index, failed, "manual-review"))
                }
              },
            },
          },
          async (owned) => {
            await compensator(cloneValue(step.compensationArgs) as C[keyof C], {
              effectId: owned.effectId,
              sagaId,
              attempt,
              signal: owned.signal,
            })
          },
        )
      } catch {
        if (transitionError !== undefined) throw transitionError
        return record
      }
    }
    return await save(record, { ...record, state: "compensated", updatedAt: now() })
  }

  const resume = async <I, C extends Record<string, unknown>>(
    definition: SagaDefinition<I, C>,
    sagaId: string,
    runOptions: { readonly signal?: AbortSignal } = {},
  ): Promise<SagaRecord> => {
    assertSagaDefinition(definition)
    assertToken(sagaId, "saga id", 128)
    const signal = signalOrNever(runOptions.signal)
    throwIfAborted(signal)
    let record = await load(sagaId)
    if (record.definition !== definition.name) throw new TypeError("saga definition mismatch")
    if (record.state !== "running") return record
    const context: SagaRunContext<C> = {
      async step(name, compensationArgs, execute) {
        throwIfAborted(signal)
        assertToken(name, "saga step", 128)
        if (typeof execute !== "function")
          throw new TypeError("saga step execute must be a function")
        if (typeof definition.compensators[name] !== "function")
          throw new TypeError(`saga step ${name} has no compensator`)
        record = await load(sagaId)
        const existingIndex = record.steps.findIndex((step) => step.name === name)
        if (existingIndex >= 0) {
          const existing = record.steps[existingIndex] as SagaStepRecord
          if (existing.state === "committed")
            return cloneValue(existing.result) as Awaited<ReturnType<typeof execute>>
          if (existing.state === "executing" || existing.state === "ambiguous") {
            if (record.state !== "manual-review")
              record = await save(record, { ...record, state: "manual-review", updatedAt: now() })
            throw new SagaAmbiguousStepError(sagaId, name, existing.effectId)
          }
          throw new Error(`saga ${sagaId}: step ${name} cannot resume from ${existing.state}`)
        }
        const effectId = crypto.randomUUID()
        const step: SagaStepRecord = Object.freeze({
          name,
          effectId,
          compensationEffectId: crypto.randomUUID(),
          state: "executing" as const,
          compensationArgs: cloneValue(compensationArgs),
          attempts: 0,
        })
        return await effectScope.run(
          {
            effectId,
            capability: definition.capability ?? "saga.execute",
            stage: "execution",
            signal,
            failurePhase: (error) =>
              error instanceof SagaStepNotCommittedError ? "failed" : "ambiguous",
            errorCode: (error, began) =>
              error instanceof SagaStepNotCommittedError
                ? error.code
                : began
                  ? "execution_unknown"
                  : "aborted_before_execution",
            transitions: {
              async intent() {
                record = await save(record, {
                  ...record,
                  steps: Object.freeze([...record.steps, step]),
                  updatedAt: now(),
                })
              },
              async committed(_owned, result) {
                record = await load(sagaId)
                const index = record.steps.findIndex((candidate) => candidate.effectId === effectId)
                const committed = {
                  ...(record.steps[index] as SagaStepRecord),
                  state: "committed" as const,
                  result: cloneValue(result),
                }
                record = await save(record, withStep(record, index, committed))
              },
              async failed(_owned, failure) {
                record = await load(sagaId)
                const index = record.steps.findIndex((candidate) => candidate.effectId === effectId)
                const known = failure.error instanceof SagaStepNotCommittedError || !failure.began
                const failed = {
                  ...(record.steps[index] as SagaStepRecord),
                  state: known ? ("failed" as const) : ("ambiguous" as const),
                  errorCode:
                    failure.error instanceof SagaStepNotCommittedError
                      ? failure.error.code
                      : failure.began
                        ? "execution_unknown"
                        : "aborted_before_execution",
                }
                record = await save(
                  record,
                  withStep(record, index, failed, known ? "compensating" : "manual-review"),
                )
              },
            },
          },
          (owned) => execute({ effectId: owned.effectId, signal: owned.signal }),
        )
      },
    }
    try {
      throwIfAborted(signal)
      await definition.run(context, cloneValue(record.input) as I)
      record = await load(sagaId)
      if (record.state === "running")
        record = await save(record, { ...record, state: "completed", updatedAt: now() })
      return record
    } catch (error) {
      record = await load(sagaId)
      if (record.state === "manual-review") throw error
      await compensate(definition, sagaId, runOptions)
      throw error
    }
  }

  const resolveAmbiguity = async <I, C extends Record<string, unknown>>(
    definition: SagaDefinition<I, C>,
    sagaId: string,
    resolution: SagaAmbiguityResolution,
  ): Promise<SagaRecord> => {
    assertSagaDefinition(definition)
    assertToken(sagaId, "saga id", 128)
    if (typeof resolution !== "object" || resolution === null)
      throw new TypeError("saga resolution must be an object")
    if (
      (resolution.kind === "execution" &&
        resolution.outcome !== "committed" &&
        resolution.outcome !== "not-committed") ||
      (resolution.kind === "compensation" &&
        resolution.outcome !== "compensated" &&
        resolution.outcome !== "not-compensated") ||
      (resolution.kind !== "execution" && resolution.kind !== "compensation")
    ) {
      throw new TypeError("saga resolution kind or outcome is invalid")
    }
    assertToken(resolution.step, "saga resolution step", 128)
    assertToken(resolution.effectId, "saga resolution effect id", 64)
    let record = await load(sagaId)
    if (record.definition !== definition.name) throw new TypeError("saga definition mismatch")
    const index = record.steps.findIndex((step) => step.name === resolution.step)
    if (index < 0) throw new SagaResolutionError(sagaId, resolution.step, "does not exist")
    const current = record.steps[index] as SagaStepRecord

    let step: SagaStepRecord
    let state: SagaState
    if (resolution.kind === "execution") {
      if (current.effectId !== resolution.effectId)
        throw new SagaResolutionError(sagaId, resolution.step, "execution effect id does not match")
      if (current.state !== "executing" && current.state !== "ambiguous")
        throw new SagaResolutionError(
          sagaId,
          resolution.step,
          `is not awaiting an execution resolution (${current.state})`,
        )
      const { errorCode: _errorCode, result: _result, ...base } = current
      if (resolution.outcome === "committed") {
        step = { ...base, state: "committed", result: cloneValue(resolution.result) }
        state = "running"
      } else {
        const errorCode = resolution.errorCode ?? "not_committed"
        if (!ERROR_CODE.test(errorCode)) throw new TypeError("saga resolution errorCode is invalid")
        step = { ...base, state: "failed", errorCode }
        state = "compensating"
      }
    } else {
      if (current.compensationEffectId !== resolution.effectId)
        throw new SagaResolutionError(
          sagaId,
          resolution.step,
          "compensation effect id does not match",
        )
      if (current.state !== "compensating")
        throw new SagaResolutionError(
          sagaId,
          resolution.step,
          `is not awaiting a compensation resolution (${current.state})`,
        )
      const { errorCode: _errorCode, nextAttemptAt: _nextAttemptAt, ...base } = current
      step = {
        ...base,
        state: resolution.outcome === "compensated" ? "compensated" : "compensation-failed",
      }
      state =
        resolution.outcome === "not-compensated" &&
        current.attempts >= (definition.retry?.maxAttempts ?? 3)
          ? "manual-review"
          : "compensating"
    }
    record = await save(record, withStep(record, index, Object.freeze(step), state))
    return record
  }

  const engine: SagaEngine = {
    async execute<I, C extends Record<string, unknown>>(
      definition: SagaDefinition<I, C>,
      sagaId: string,
      input: I,
      runOptions: { readonly signal?: AbortSignal } = {},
    ) {
      assertSagaDefinition(definition)
      assertToken(sagaId, "saga id", 128)
      throwIfAborted(signalOrNever(runOptions.signal))
      const at = now()
      const accepted = await options.store.create(
        Object.freeze({
          sagaId,
          definition: definition.name,
          state: "running" as const,
          input: cloneValue(input),
          steps: Object.freeze([]),
          createdAt: at,
          updatedAt: at,
          version: 1,
        }),
      )
      if (!accepted) throw new Error(`saga ${sagaId}: already exists`)
      return await resume(definition, sagaId, runOptions)
    },
    resume,
    compensate,
    resolveAmbiguity,
  }
  return Object.freeze(engine)
}

export class MemorySagaStore implements SagaStore {
  readonly durability = "memory" as const
  private readonly records = new Map<string, SagaRecord>()
  // Secondary index: sagaIds grouped by state, so reconciliation scans only the requested (few,
  // non-terminal) states instead of walking every retained record. See {@link indexedScan}.
  private readonly byState = new Map<SagaState, Set<string>>()
  create(record: SagaRecord): boolean {
    if (this.records.has(record.sagaId)) return false
    this.records.set(record.sagaId, Object.freeze(cloneValue(record)))
    bucketAdd(this.byState, record.state, record.sagaId)
    return true
  }
  get(sagaId: string): SagaRecord | undefined {
    const record = this.records.get(sagaId)
    return record === undefined ? undefined : Object.freeze(cloneValue(record))
  }
  compareAndSet(input: Parameters<SagaStore["compareAndSet"]>[0]): boolean {
    const current = this.records.get(input.sagaId)
    const next = durableSagaProtocol.transition(current, input)
    if (next === undefined) return false
    if (current === undefined) return false
    this.records.set(input.sagaId, Object.freeze(next))
    bucketMove(this.byState, current.state, input.record.state, input.sagaId)
    return true
  }
  list(): readonly SagaRecord[] {
    return Object.freeze(
      [...this.records.values()].map((record) => Object.freeze(cloneValue(record))),
    )
  }

  scan(input: ReconciliationScanOptions<SagaState>): ReconciliationScanPage<SagaRecord> {
    return indexedScan(this.byState, (id) => this.records.get(id), input)
  }
}

export interface SagaReconciliationFinding {
  readonly sagaId: string
  readonly state: SagaState
  readonly step?: string
  readonly effectId?: string
  readonly reason:
    | "stale-running"
    | "ambiguous-execution"
    | "ambiguous-compensation"
    | "manual-review"
}

async function scanSagaRecords(
  store: SagaStore,
  input: ReconciliationScanOptions<SagaState>,
): Promise<ReconciliationScanPage<SagaRecord>> {
  if (store.scan !== undefined) return await store.scan(input)
  if (store.list === undefined) throw new TypeError("saga store does not support reconciliation")
  return memoryScan(await store.list(), input)
}

export async function reconcileSagasPage(
  store: SagaStore,
  options: { readonly staleBefore: number; readonly cursor?: string; readonly limit?: number },
): Promise<ReconciliationPage<SagaReconciliationFinding>> {
  const findings: SagaReconciliationFinding[] = []
  const page = await scanSagaRecords(store, {
    states: ["running", "compensating", "manual-review"],
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    limit: reconciliationLimit(options.limit),
  })
  for (const record of page.records) {
    const ambiguous = record.steps.find(
      (step) =>
        step.state === "executing" || step.state === "ambiguous" || step.state === "compensating",
    )
    if (ambiguous !== undefined) {
      findings.push(
        Object.freeze({
          sagaId: record.sagaId,
          state: record.state,
          step: ambiguous.name,
          effectId:
            ambiguous.state === "compensating"
              ? ambiguous.compensationEffectId
              : ambiguous.effectId,
          reason:
            ambiguous.state === "compensating" ? "ambiguous-compensation" : "ambiguous-execution",
        }),
      )
    } else if (record.state === "manual-review") {
      findings.push(
        Object.freeze({ sagaId: record.sagaId, state: record.state, reason: "manual-review" }),
      )
    } else if (
      (record.state === "running" || record.state === "compensating") &&
      record.updatedAt <= options.staleBefore
    ) {
      findings.push(
        Object.freeze({ sagaId: record.sagaId, state: record.state, reason: "stale-running" }),
      )
    }
  }
  return Object.freeze({
    findings: Object.freeze(findings),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  })
}

export async function reconcileSagas(
  store: SagaStore,
  options: { readonly staleBefore: number },
): Promise<readonly SagaReconciliationFinding[]> {
  const page = await reconcileSagasPage(store, {
    ...options,
    limit: MAX_RECONCILIATION_LIMIT,
  })
  if (page.cursor !== undefined) {
    throw new RangeError(
      `saga reconciliation exceeds ${MAX_RECONCILIATION_LIMIT} records; use reconcileSagasPage()`,
    )
  }
  return page.findings
}
