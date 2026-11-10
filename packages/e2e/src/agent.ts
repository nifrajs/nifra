import { type InferOutput, type StandardSchemaV1, validateStandard } from "@nifrajs/core/schema"
import { type Cache, type CacheEntry, performedOf, type RecordedAction } from "./cache.ts"
import {
  type ActDecision,
  type PerformedDecision,
  parseActDecision,
  parseExtraction,
  parseVerdict,
  targetSelector,
} from "./decision.ts"
import { type Clock, E2EError, type Engine } from "./engine.ts"
import { diffEvidence } from "./evidence.ts"
import { forModel, forPage, type Params, redact, Secret, templatize } from "./params.ts"
import { replayEntry, type StopReason, visibleCount, withoutNth } from "./replay.ts"
import { normalizeRoute } from "./route.ts"
import { pruneSnapshot } from "./snapshot.ts"

/** One thing the agent tried inside a goal, and whether the page took it. */
export interface ActionRecord {
  readonly action: PerformedDecision
  readonly ok: boolean
  readonly error?: string
}

/** A recorded run that stopped partway: its actions are already done, so do not redo them. */
export interface HandOff {
  readonly reason: StopReason
  readonly detail: string
  /** How many actions at the start of `history` the replay performed. */
  readonly performed: number
}

export interface ActRequest {
  readonly kind: "act"
  readonly goal: string
  readonly context?: string
  readonly snapshot: string
  readonly history: readonly ActionRecord[]
  /** Names of params whose values stay out of the goal and the snapshot; write `{name}` to type one. */
  readonly secrets: readonly string[]
  readonly modelCallsLeft: number
  readonly actionsLeft: number
  readonly handoff: HandOff | undefined
  readonly signal: AbortSignal
}

export interface JudgeRequest {
  readonly kind: "assert" | "waitFor"
  readonly statement: string
  readonly context?: string
  readonly snapshot: string
  readonly secrets: readonly string[]
  readonly signal: AbortSignal
}

export interface ExtractRequest {
  readonly kind: "extract"
  readonly prompt: string
  readonly context?: string
  readonly snapshot: string
  readonly secrets: readonly string[]
  /** The JSON Schema the caller supplied, to put in the prompt; the answer is validated against the real schema. */
  readonly jsonSchema?: unknown
  readonly signal: AbortSignal
}

export type ModelRequest = ActRequest | JudgeRequest | ExtractRequest

/**
 * The seam to a model. Answer an `act` request with a decision (`{ kind: "tap", target }`, `fill`,
 * `press`, `goto`, `done` or `fail`), an `assert` or `waitFor` with `{ pass, reason }`, and an
 * `extract` with `{ value }`. The answer is unknown until the runner has parsed it. Nothing here
 * names a vendor; the caller owns credentials, retries and cost.
 */
export interface E2EModel {
  decide(request: ModelRequest): unknown | PromiseLike<unknown>
}

export interface StepOptions {
  readonly params?: Params
  readonly signal?: AbortSignal
}

export interface ActOptions extends StepOptions {
  /** Model decisions one goal may use. Default 12. */
  readonly maxModelCalls?: number
  /** Page actions one goal may take, failed ones included. Default 25. */
  readonly maxActions?: number
  /** ms for the whole goal on the session clock. Default 120000. */
  readonly timeout?: number
}

export interface WaitForOptions extends StepOptions {
  /** ms to wait for the statement to hold. Default 30000. */
  readonly timeout?: number
}

export interface ExtractOptions<S extends StandardSchemaV1> extends StepOptions {
  readonly schema: S
  readonly jsonSchema?: unknown
}

export interface ActResult {
  /** `replay`: no model call. `handoff`: a recording stopped and the model finished the goal. */
  readonly source: "model" | "replay" | "handoff"
  readonly modelCalls: number
  /** The actions the page accepted, in order. */
  readonly actions: readonly PerformedDecision[]
  readonly summary?: string
}

/** What the replay cache did for this session, and how many model calls it still took. */
export interface AgentReport {
  readonly replayed: number
  readonly handedOff: number
  readonly missed: number
  readonly modelCalls: number
}

export function formatReport(report: AgentReport): string {
  return `Cache: ${report.replayed} replayed - ${report.handedOff} handed off - ${report.missed} missed (${report.modelCalls} model calls)`
}

export interface Agent {
  report(): AgentReport
  act(goal: string, options?: ActOptions): Promise<ActResult>
  assert(statement: string, options?: StepOptions): Promise<void>
  waitFor(statement: string, options?: WaitForOptions): Promise<void>
  extract<S extends StandardSchemaV1>(
    prompt: string,
    options: ExtractOptions<S>,
  ): Promise<InferOutput<S>>
}

export interface AgentDeps {
  readonly engine: Engine
  readonly clock: Clock
  readonly pollInterval: number
  readonly actionTimeout: number
  readonly model: E2EModel | undefined
  readonly context: string | undefined
  readonly snapshotChars: number
  /** Origin of the app under test. */
  readonly origin: string
  readonly cache: Cache | undefined
  /** Opens a same-origin path; refuses any other. */
  readonly navigate: (path: string) => Promise<void>
}

const NEVER = new AbortController().signal

function withContext(context: string | undefined): { context?: string } {
  return context === undefined ? {} : { context }
}

function entryOf(
  goal: string,
  startRoute: string,
  actions: readonly RecordedAction[],
  before: string,
  after: string,
  route: string,
  params: Params,
): CacheEntry {
  const changes = diffEvidence(before, after)
  return {
    version: 1,
    instruction: goal,
    startRoute,
    actions,
    end: {
      route,
      appeared: changes.appeared.map((line) => templatize(line, params)),
      disappeared: changes.disappeared.map((line) => templatize(line, params)),
    },
  }
}

export function createAgent(deps: AgentDeps): Agent {
  const { engine, clock, cache } = deps
  const stats = { replayed: 0, handedOff: 0, missed: 0, modelCalls: 0 }

  const requireModel = (): E2EModel => {
    if (deps.model === undefined) {
      throw new E2EError("MODEL_MISSING", "this step needs a model: pass `model` to e2e()")
    }
    return deps.model
  }

  const ask = async (model: E2EModel, request: ModelRequest): Promise<unknown> => {
    stats.modelCalls += 1
    return model.decide(request)
  }

  // Every secret any step has been given stays redacted for the whole session: a value typed in one
  // step is still on the page when a later step, which was not handed it, takes a snapshot.
  const vault: Record<string, Secret> = {}
  const remember = (params: Params): void => {
    for (const [name, param] of Object.entries(params)) {
      if (param instanceof Secret) vault[name] = param
    }
  }

  const observe = async (): Promise<{ raw: string; shown: string }> => {
    const raw = redact(await engine.snapshot(), vault)
    return { raw, shown: pruneSnapshot(raw, deps.snapshotChars) }
  }
  const look = async (): Promise<string> => (await observe()).shown

  interface Taken {
    readonly record: ActionRecord
    readonly recorded: RecordedAction | undefined
  }

  const perform = async (
    decision: PerformedDecision,
    params: Params,
    recording: boolean,
  ): Promise<Taken> => {
    try {
      if (decision.kind === "goto") {
        await deps.navigate(decision.path)
        return {
          record: { action: decision, ok: true },
          recorded: recording
            ? { kind: "goto", path: templatize(decision.path, params) }
            : undefined,
        }
      }
      const selector = targetSelector(decision.target)
      const matches = recording ? await visibleCount(engine, withoutNth(selector)) : 1
      let recorded: RecordedAction
      if (decision.kind === "tap") {
        await engine.act(selector, { kind: "tap" }, deps.actionTimeout)
        recorded = { kind: "tap", target: decision.target, matches }
      } else if (decision.kind === "fill") {
        const value = forPage(decision.value, params)
        await engine.act(selector, { kind: "fill", value }, deps.actionTimeout)
        recorded = {
          kind: "fill",
          target: decision.target,
          matches,
          value: templatize(decision.value, params),
        }
      } else {
        await engine.act(selector, { kind: "press", key: decision.key }, deps.actionTimeout)
        recorded = { kind: "press", target: decision.target, matches, key: decision.key }
      }
      return { record: { action: decision, ok: true }, recorded: recording ? recorded : undefined }
    } catch (error) {
      if (error instanceof E2EError || error instanceof TypeError) {
        return {
          record: { action: decision, ok: false, error: error.message },
          recorded: undefined,
        }
      }
      throw error
    }
  }

  return {
    report: () => ({ ...stats }),

    async act(goal, options = {}) {
      const params = options.params ?? {}
      remember(params)
      const { text, secrets } = forModel(goal, params)
      const maxCalls = options.maxModelCalls ?? 12
      const maxActions = options.maxActions ?? 25
      const deadline = clock.now() + (options.timeout ?? 120_000)
      const recording = cache?.canWrite === true
      const key =
        cache === undefined || cache.mode === "off"
          ? undefined
          : cache.key(goal, params, deps.context)
      const startRoute = normalizeRoute(await engine.url(), deps.origin)
      const before = recording ? (await observe()).raw : ""

      const history: ActionRecord[] = []
      const taken: RecordedAction[] = []
      let handoff: HandOff | undefined
      if (cache !== undefined && key !== undefined) {
        const entry = await cache.read(key)
        if (entry === undefined) {
          if (cache.mode === "strict") {
            throw new E2EError(
              "REPLAY_MISSING",
              `goal "${text}" has no recording and the cache is strict`,
            )
          }
          stats.missed += 1
        } else {
          const outcome = await replayEntry(
            { ...deps, observe: async () => (await observe()).raw },
            entry,
            params,
          )
          if (outcome.ok) {
            stats.replayed += 1
            cache.replayed(key)
            return { source: "replay", modelCalls: 0, actions: entry.actions.map(performedOf) }
          }
          if (cache.mode === "strict") {
            throw new E2EError(
              "REPLAY_STALE",
              `goal "${text}" no longer replays (${outcome.reason}): ${outcome.detail}`,
            )
          }
          stats.handedOff += 1
          handoff = {
            reason: outcome.reason,
            detail: outcome.detail,
            performed: outcome.performed.length,
          }
          for (const action of outcome.performed) {
            taken.push(action)
            history.push({ action: performedOf(action), ok: true })
          }
        }
      }

      const runGoal = async (): Promise<ActResult> => {
        let calls = 0
        let latest = before
        for (;;) {
          if (clock.now() >= deadline) {
            throw new E2EError("STEP_TIMEOUT", `goal "${text}" ran past its time limit`)
          }
          if (calls >= maxCalls) {
            throw new E2EError(
              "STEP_BUDGET_EXCEEDED",
              `goal "${text}" used its ${maxCalls} model calls`,
            )
          }
          const model = requireModel()
          const seen = await observe()
          latest = seen.raw
          calls += 1
          const raw = await ask(model, {
            kind: "act",
            goal: text,
            ...withContext(deps.context),
            snapshot: seen.shown,
            history,
            secrets,
            modelCallsLeft: maxCalls - calls,
            actionsLeft: maxActions - history.length,
            handoff,
            signal: options.signal ?? NEVER,
          })
          const parsed = parseActDecision(raw)
          if (!parsed.ok) {
            throw new E2EError(
              "MODEL_INVALID",
              `the model's decision was refused: ${parsed.reason}`,
            )
          }
          const decision: ActDecision = parsed.value
          if (decision.kind === "fail") {
            throw new E2EError("STEP_FAILED", `goal "${text}" failed: ${decision.reason}`)
          }
          if (decision.kind === "done") {
            if (recording && cache !== undefined && key !== undefined && taken.length > 0) {
              cache.stage(
                key,
                entryOf(
                  goal,
                  startRoute,
                  taken,
                  before,
                  latest,
                  normalizeRoute(await engine.url(), deps.origin),
                  params,
                ),
              )
            }
            const result: {
              source: ActResult["source"]
              modelCalls: number
              actions: PerformedDecision[]
              summary?: string
            } = {
              source: handoff === undefined ? "model" : "handoff",
              modelCalls: calls,
              actions: history.filter((entry) => entry.ok).map((entry) => entry.action),
            }
            if (decision.summary !== undefined) result.summary = decision.summary
            return result
          }
          if (history.length >= maxActions) {
            throw new E2EError(
              "STEP_BUDGET_EXCEEDED",
              `goal "${text}" used its ${maxActions} actions`,
            )
          }
          const step = await perform(decision, params, recording)
          history.push(step.record)
          if (step.recorded !== undefined) taken.push(step.recorded)
        }
      }

      try {
        return await runGoal()
      } catch (error) {
        const missingModel = error instanceof E2EError && error.code === "MODEL_MISSING"
        if (handoff !== undefined && !missingModel && cache !== undefined && key !== undefined) {
          await cache.discard(key)
        }
        throw error
      }
    },

    async assert(statement, options = {}) {
      const model = requireModel()
      const params = options.params ?? {}
      remember(params)
      const { text, secrets } = forModel(statement, params)
      const raw = await ask(model, {
        kind: "assert",
        statement: text,
        ...withContext(deps.context),
        snapshot: await look(),
        secrets,
        signal: options.signal ?? NEVER,
      })
      const verdict = parseVerdict(raw)
      if (!verdict.ok) {
        throw new E2EError("MODEL_INVALID", `the model's verdict was refused: ${verdict.reason}`)
      }
      if (verdict.value.pass === true) {
        await cache?.onCheck(true)
        return
      }
      const reason = verdict.value.reason === "" ? "" : `: ${verdict.value.reason}`
      if (verdict.value.pass === "inconclusive") {
        throw new E2EError("ASSERTION_INCONCLUSIVE", `could not tell whether "${text}"${reason}`)
      }
      await cache?.onCheck(false)
      throw new E2EError("ASSERTION_FAILED", `"${text}" does not hold${reason}`)
    },

    async waitFor(statement, options = {}) {
      const model = requireModel()
      const params = options.params ?? {}
      remember(params)
      const { text, secrets } = forModel(statement, params)
      const timeout = options.timeout ?? 30_000
      const deadline = clock.now() + timeout
      let seen: string | undefined
      let lastReason = ""
      for (;;) {
        const snapshot = await look()
        if (snapshot !== seen) {
          seen = snapshot
          const raw = await ask(model, {
            kind: "waitFor",
            statement: text,
            ...withContext(deps.context),
            snapshot,
            secrets,
            signal: options.signal ?? NEVER,
          })
          const verdict = parseVerdict(raw)
          if (!verdict.ok) {
            throw new E2EError(
              "MODEL_INVALID",
              `the model's verdict was refused: ${verdict.reason}`,
            )
          }
          if (verdict.value.pass === true) {
            await cache?.onCheck(true)
            return
          }
          lastReason = verdict.value.reason
        }
        const remaining = deadline - clock.now()
        if (remaining <= 0) {
          await cache?.onCheck(false)
          const reason = lastReason === "" ? "" : `: ${lastReason}`
          throw new E2EError("WAIT_TIMEOUT", `"${text}" did not hold within ${timeout} ms${reason}`)
        }
        await clock.sleep(Math.min(deps.pollInterval, remaining))
      }
    },

    async extract(prompt, options) {
      const model = requireModel()
      const params = options.params ?? {}
      remember(params)
      const { text, secrets } = forModel(prompt, params)
      const raw = await ask(model, {
        kind: "extract",
        prompt: text,
        ...withContext(deps.context),
        snapshot: await look(),
        secrets,
        ...(options.jsonSchema === undefined ? {} : { jsonSchema: options.jsonSchema }),
        signal: options.signal ?? NEVER,
      })
      const extraction = parseExtraction(raw)
      if (!extraction.ok) {
        throw new E2EError("MODEL_INVALID", `the model's answer was refused: ${extraction.reason}`)
      }
      const checked = await validateStandard(options.schema, extraction.value)
      if (!checked.ok) {
        const issues = checked.issues.map((issue) => issue.message).join("; ")
        throw new E2EError(
          "EXTRACT_INVALID",
          `the extracted data does not match the schema: ${issues}`,
        )
      }
      return checked.value
    },
  }
}
