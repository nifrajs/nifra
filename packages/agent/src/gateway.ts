/**
 * Provider-neutral model gateway contracts.
 *
 * This module is deliberately an adapter seam. It knows how to bound an attempt, validate an
 * untrusted adapter result, and record safe evidence; it does not know provider SDKs, credentials,
 * prompts, pricing, or a routing service. Request input and model output are transient caller data.
 * Only the returned evidence may cross a public reference boundary.
 */

import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import { validateStandard } from "@nifrajs/core/schema"

export const MODEL_GATEWAY_ERROR_CODES = [
  "malformed_output",
  "refusal",
  "timeout",
  "rate_limit",
  "unavailable",
  "policy_denied",
  "cancelled",
  "internal",
] as const

export type ModelGatewayErrorCode = (typeof MODEL_GATEWAY_ERROR_CODES)[number]

const ERROR_CODES: ReadonlySet<string> = new Set(MODEL_GATEWAY_ERROR_CODES)
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_ATTEMPTS = 512
const MAX_TOKENS = 10_000_000
const MAX_EVIDENCE = 512

export interface ModelRoute {
  /** Caller-owned opaque route identifier. It is not a provider or model name. */
  readonly id: string
}

export type ModelRouteRef = string | ModelRoute

export interface ModelGatewayBudget {
  readonly maxAttempts: number
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
}

export interface ModelGatewayUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface ModelGatewayEnvelope {
  readonly attempt: number
  readonly attemptsRemaining: number
  readonly inputTokensRemaining?: number
  readonly outputTokensRemaining?: number
  readonly deadlineAt?: number
}

/** The transient request given to a leaf adapter. Never copy `input` into evidence. */
export interface ModelGatewayAttemptRequest<Input = unknown> {
  readonly routeId: string
  readonly input: Input
  readonly signal: AbortSignal
  readonly envelope: ModelGatewayEnvelope
}

export interface ModelGatewayRequest<Input = unknown, Output = unknown> {
  readonly input: Input
  /** Optional initial route. If omitted, the first route in the caller policy is used. */
  readonly routeId?: string
  readonly parser?: StructuredOutputParser<Output>
  readonly signal?: AbortSignal
}

export interface ModelGatewaySuccess {
  readonly ok: true
  readonly output: unknown
  readonly usage?: ModelGatewayUsage
}

export interface ModelGatewayFailure {
  readonly ok: false
  readonly error: ModelGatewayError
}

export type ModelGatewayRawResult = ModelGatewaySuccess | ModelGatewayFailure

/** A leaf adapter may be backed by any provider, but it must return this parsed envelope. */
export interface ModelGateway {
  complete(
    request: ModelGatewayAttemptRequest,
  ): ModelGatewayRawResult | PromiseLike<ModelGatewayRawResult> | unknown
}

export interface ModelGatewayError {
  readonly code: ModelGatewayErrorCode
}

export class ModelGatewayFailureError extends Error {
  readonly code: ModelGatewayErrorCode

  constructor(code: ModelGatewayErrorCode) {
    super(`model gateway ${code}`)
    this.name = "ModelGatewayFailureError"
    this.code = code
  }
}

export function isModelGatewayErrorCode(value: unknown): value is ModelGatewayErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value)
}

/** Normalize arbitrary adapter failures without retaining their message, stack, or cause. */
export function parseModelGatewayError(value: unknown): ModelGatewayError {
  if (value instanceof ModelGatewayFailureError) return Object.freeze({ code: value.code })
  if (isRecord(value) && isModelGatewayErrorCode(value.code)) {
    if (Object.keys(value).some((key) => key !== "code")) return Object.freeze({ code: "internal" })
    return Object.freeze({ code: value.code })
  }
  return Object.freeze({ code: "internal" })
}

/** Parse the leaf result before policy or structured-output code sees it. */
export function parseModelGatewayResult(value: unknown): ModelGatewayRawResult {
  if (!isRecord(value) || typeof value.ok !== "boolean")
    return { ok: false, error: { code: "internal" } }
  if (!value.ok) {
    if (Object.keys(value).some((key) => key !== "ok" && key !== "error"))
      return { ok: false, error: { code: "malformed_output" } }
    return { ok: false, error: parseModelGatewayError(value.error) }
  }
  if (Object.keys(value).some((key) => key !== "ok" && key !== "output" && key !== "usage"))
    return { ok: false, error: { code: "malformed_output" } }
  if (!Object.hasOwn(value, "output")) return { ok: false, error: { code: "malformed_output" } }
  let usage: ModelGatewayUsage | undefined
  if (value.usage !== undefined) {
    const parsed = parseUsage(value.usage)
    if (parsed === undefined) return { ok: false, error: { code: "malformed_output" } }
    usage = parsed
  }
  return Object.freeze({
    ok: true,
    output: value.output,
    ...(usage === undefined ? {} : { usage }),
  })
}

export interface StructuredOutputParser<Output> {
  readonly parse: (value: unknown) => Output | PromiseLike<Output>
}

/** Adapt any Standard Schema validator into a strict structured-output parser. */
export function createStructuredOutputParser<Schema extends StandardSchemaV1>(
  schema: Schema,
): StructuredOutputParser<NonNullable<Schema["~standard"]["types"]>["output"]> {
  return {
    async parse(value) {
      const result = await validateStandard(schema, value)
      if (!result.ok) throw new ModelGatewayFailureError("malformed_output")
      return result.value
    },
  }
}

export function structuredOutputParser<Output>(
  parse: (value: unknown) => Output | PromiseLike<Output>,
): StructuredOutputParser<Output> {
  if (typeof parse !== "function") throw new TypeError("structured output parser must be callable")
  return Object.freeze({ parse })
}

export interface ModelGatewayEvidenceBase {
  readonly kind: "attempt" | "fallback" | "parse" | "terminal"
  readonly routeId: string
  readonly attempt: number
}

export type ModelGatewayEvidence =
  | (ModelGatewayEvidenceBase & {
      readonly kind: "attempt"
      readonly outcome: "started" | "passed" | "failed"
      readonly code?: ModelGatewayErrorCode
    })
  | (ModelGatewayEvidenceBase & {
      readonly kind: "fallback"
      readonly fromRouteId: string
      readonly toRouteId: string
    })
  | (ModelGatewayEvidenceBase & {
      readonly kind: "parse"
      readonly outcome: "passed" | "failed"
      readonly code?: "malformed_output"
    })
  | (ModelGatewayEvidenceBase & {
      readonly kind: "terminal"
      readonly outcome: "passed" | "failed"
      readonly code?: ModelGatewayErrorCode
    })

export interface ModelGatewayResult<Output> {
  readonly ok: true
  readonly output: Output
  readonly routeId: string
  readonly attempts: number
  readonly usage: ModelGatewayUsage
  readonly evidence: readonly ModelGatewayEvidence[]
}

export interface ModelGatewayTerminalFailure {
  readonly ok: false
  readonly error: ModelGatewayError
  readonly routeId: string
  readonly attempts: number
  readonly usage: ModelGatewayUsage
  readonly evidence: readonly ModelGatewayEvidence[]
}

export type ModelGatewayExecutionResult<Output> =
  | ModelGatewayResult<Output>
  | ModelGatewayTerminalFailure

export interface ModelRoutePolicy {
  readonly routes: readonly ModelRouteRef[]
  readonly retryableCodes: readonly ModelGatewayErrorCode[]
  readonly maxAttempts?: number
  readonly allowFallback?: boolean
  readonly budget?: ModelGatewayBudget
  readonly deadlineAt?: number
  readonly now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function routeId(value: ModelRouteRef): string {
  const id = typeof value === "string" ? value : value.id
  if (typeof id !== "string" || !TOKEN.test(id)) throw new TypeError("model route id is invalid")
  return id
}

function integer(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
}

function parseUsage(value: unknown): ModelGatewayUsage | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = value.inputTokens
  const outputTokens = value.outputTokens
  if (inputTokens !== undefined && !integer(inputTokens, MAX_TOKENS)) return undefined
  if (outputTokens !== undefined && !integer(outputTokens, MAX_TOKENS)) return undefined
  return Object.freeze({
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  })
}

function validateBudget(budget: ModelGatewayBudget | undefined): ModelGatewayBudget {
  const value = budget ?? { maxAttempts: 1 }
  if (!integer(value.maxAttempts, MAX_ATTEMPTS) || value.maxAttempts < 1)
    throw new TypeError("model gateway maxAttempts is invalid")
  if (value.maxInputTokens !== undefined && !integer(value.maxInputTokens, MAX_TOKENS))
    throw new TypeError("model gateway maxInputTokens is invalid")
  if (value.maxOutputTokens !== undefined && !integer(value.maxOutputTokens, MAX_TOKENS))
    throw new TypeError("model gateway maxOutputTokens is invalid")
  return Object.freeze({ ...value })
}

function validatePolicy(policy: ModelRoutePolicy): {
  routes: readonly string[]
  retryableCodes: ReadonlySet<ModelGatewayErrorCode>
  maxAttempts: number
  budget: ModelGatewayBudget
  now: () => number
} {
  if (
    !Array.isArray(policy.routes) ||
    policy.routes.length === 0 ||
    policy.routes.length > MAX_ATTEMPTS
  )
    throw new TypeError("model gateway policy requires bounded routes")
  const routes = policy.routes.map(routeId)
  if (new Set(routes).size !== routes.length)
    throw new TypeError("model gateway routes must be unique")
  const retryableCodes = new Set<ModelGatewayErrorCode>()
  for (const code of policy.retryableCodes) {
    if (!isModelGatewayErrorCode(code)) throw new TypeError("model gateway retry code is invalid")
    retryableCodes.add(code)
  }
  const budget = validateBudget(policy.budget)
  const maxAttempts = policy.maxAttempts ?? budget.maxAttempts
  if (!integer(maxAttempts, MAX_ATTEMPTS) || maxAttempts < 1)
    throw new TypeError("model gateway policy maxAttempts is invalid")
  if (
    policy.deadlineAt !== undefined &&
    (!Number.isSafeInteger(policy.deadlineAt) || policy.deadlineAt <= 0)
  )
    throw new TypeError("model gateway deadlineAt is invalid")
  return { routes, retryableCodes, maxAttempts, budget, now: policy.now ?? Date.now }
}

function evidenceLimit(evidence: ModelGatewayEvidence[]): void {
  if (evidence.length >= MAX_EVIDENCE) throw new ModelGatewayFailureError("policy_denied")
}

function addEvidence(evidence: ModelGatewayEvidence[], value: ModelGatewayEvidence): void {
  evidenceLimit(evidence)
  evidence.push(Object.freeze(value))
}

function terminal(
  error: ModelGatewayError,
  route: string,
  attempts: number,
  usage: ModelGatewayUsage,
  evidence: ModelGatewayEvidence[],
): ModelGatewayTerminalFailure {
  addEvidence(evidence, {
    kind: "terminal",
    routeId: route,
    attempt: attempts,
    outcome: "failed",
    code: error.code,
  })
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: error.code }),
    routeId: route,
    attempts,
    usage: Object.freeze({ ...usage }),
    evidence: Object.freeze([...evidence]),
  })
}

function timedFailure(
  signal: AbortSignal,
  deadlineAt: number | undefined,
  now: () => number,
): ModelGatewayError | undefined {
  if (signal.aborted) return { code: "cancelled" }
  if (deadlineAt !== undefined && now() >= deadlineAt) return { code: "timeout" }
  return undefined
}

async function settleAttempt(
  gateway: ModelGateway,
  request: ModelGatewayAttemptRequest,
  deadlineAt: number | undefined,
  now: () => number,
): Promise<ModelGatewayRawResult> {
  const before = timedFailure(request.signal, deadlineAt, now)
  if (before !== undefined) return { ok: false, error: before }
  const remaining = deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - now())
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const operation = Promise.resolve()
      .then(() => gateway.complete(request))
      .then(parseModelGatewayResult, () => ({
        ok: false as const,
        error: { code: "internal" as const },
      }))
    const races: Promise<ModelGatewayRawResult>[] = [operation]
    if (remaining !== undefined) {
      races.push(
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, error: { code: "timeout" } }), remaining)
        }),
      )
    }
    if (!request.signal.aborted) {
      races.push(
        new Promise((resolve) => {
          abort = () => resolve({ ok: false, error: { code: "cancelled" } })
          request.signal.addEventListener("abort", abort!, { once: true })
        }),
      )
    }
    return await Promise.race(races)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort !== undefined) request.signal.removeEventListener("abort", abort)
  }
}

/** Execute a gateway under an explicit route, retry, fallback, budget, and deadline policy. */
export async function runModelGateway<Input, Output>(
  gateway: ModelGateway,
  request: ModelGatewayRequest<Input, Output>,
  policy: ModelRoutePolicy,
): Promise<ModelGatewayExecutionResult<Output>> {
  if (gateway === null || typeof gateway !== "object" || typeof gateway.complete !== "function")
    throw new TypeError("model gateway must implement complete")
  const checked = validatePolicy(policy)
  if (request.routeId !== undefined && !checked.routes.includes(request.routeId))
    return terminal({ code: "policy_denied" }, checked.routes[0]!, 0, {}, [])
  const start = request.routeId === undefined ? 0 : checked.routes.indexOf(request.routeId)
  const routes = checked.routes.slice(start)
  const maxAttempts = Math.min(checked.maxAttempts, checked.budget.maxAttempts)
  const signal = request.signal ?? new AbortController().signal
  const evidence: ModelGatewayEvidence[] = []
  const usage = { inputTokens: 0, outputTokens: 0 }
  let attempts = 0
  let routeIndex = 0
  let lastRoute = routes[0]!

  while (attempts < maxAttempts) {
    const route = routes[routeIndex]!
    lastRoute = route
    attempts += 1
    const attemptsRemaining = maxAttempts - attempts
    const inputTokensRemaining =
      checked.budget.maxInputTokens === undefined
        ? undefined
        : Math.max(0, checked.budget.maxInputTokens - usage.inputTokens)
    const outputTokensRemaining =
      checked.budget.maxOutputTokens === undefined
        ? undefined
        : Math.max(0, checked.budget.maxOutputTokens - usage.outputTokens)
    const envelope = Object.freeze({
      attempt: attempts,
      attemptsRemaining,
      ...(inputTokensRemaining === undefined ? {} : { inputTokensRemaining }),
      ...(outputTokensRemaining === undefined ? {} : { outputTokensRemaining }),
      ...(policy.deadlineAt === undefined ? {} : { deadlineAt: policy.deadlineAt }),
    })
    addEvidence(evidence, {
      kind: "attempt",
      routeId: route,
      attempt: attempts,
      outcome: "started",
    })
    const raw = await settleAttempt(
      gateway,
      { routeId: route, input: request.input, signal, envelope },
      policy.deadlineAt,
      checked.now,
    )
    const parsed = parseModelGatewayResult(raw)
    if (parsed.ok) {
      const inputTokens = parsed.usage?.inputTokens ?? 0
      const outputTokens = parsed.usage?.outputTokens ?? 0
      if (
        usage.inputTokens + inputTokens > (checked.budget.maxInputTokens ?? MAX_TOKENS) ||
        usage.outputTokens + outputTokens > (checked.budget.maxOutputTokens ?? MAX_TOKENS)
      ) {
        addEvidence(evidence, {
          kind: "attempt",
          routeId: route,
          attempt: attempts,
          outcome: "failed",
          code: "policy_denied",
        })
        return terminal({ code: "policy_denied" }, route, attempts, usage, evidence)
      }
      usage.inputTokens += inputTokens
      usage.outputTokens += outputTokens
      addEvidence(evidence, {
        kind: "attempt",
        routeId: route,
        attempt: attempts,
        outcome: "passed",
      })
      if (request.parser !== undefined) {
        try {
          const output = await request.parser.parse(parsed.output)
          addEvidence(evidence, {
            kind: "parse",
            routeId: route,
            attempt: attempts,
            outcome: "passed",
          })
          addEvidence(evidence, {
            kind: "terminal",
            routeId: route,
            attempt: attempts,
            outcome: "passed",
          })
          return Object.freeze({
            ok: true,
            output,
            routeId: route,
            attempts,
            usage: Object.freeze({ ...usage }),
            evidence: Object.freeze([...evidence]),
          })
        } catch {
          addEvidence(evidence, {
            kind: "parse",
            routeId: route,
            attempt: attempts,
            outcome: "failed",
            code: "malformed_output",
          })
          const parseError: ModelGatewayError = { code: "malformed_output" }
          addEvidence(evidence, {
            kind: "attempt",
            routeId: route,
            attempt: attempts,
            outcome: "failed",
            code: parseError.code,
          })
          if (!checked.retryableCodes.has(parseError.code))
            return terminal(parseError, route, attempts, usage, evidence)
        }
      } else {
        addEvidence(evidence, {
          kind: "terminal",
          routeId: route,
          attempt: attempts,
          outcome: "passed",
        })
        return Object.freeze({
          ok: true,
          output: parsed.output as Output,
          routeId: route,
          attempts,
          usage: Object.freeze({ ...usage }),
          evidence: Object.freeze([...evidence]),
        })
      }
    } else {
      addEvidence(evidence, {
        kind: "attempt",
        routeId: route,
        attempt: attempts,
        outcome: "failed",
        code: parsed.error.code,
      })
      const retryable = checked.retryableCodes.has(parsed.error.code)
      if (!retryable) return terminal(parsed.error, route, attempts, usage, evidence)
    }

    if (attempts >= maxAttempts) break
    if (routeIndex + 1 < routes.length && policy.allowFallback === true) {
      const nextRoute = routes[routeIndex + 1]!
      addEvidence(evidence, {
        kind: "fallback",
        routeId: nextRoute,
        fromRouteId: route,
        toRouteId: nextRoute,
        attempt: attempts,
      })
      routeIndex += 1
    }
    const stopped = timedFailure(signal, policy.deadlineAt, checked.now)
    if (stopped !== undefined) return terminal(stopped, lastRoute, attempts, usage, evidence)
  }
  return terminal({ code: "unavailable" }, lastRoute, attempts, usage, evidence)
}

export interface FakeModelGatewayOptions {
  readonly responses: readonly ModelGatewayRawResult[]
}

/** Deterministic, network-free gateway for tests and local examples. It records no request input. */
export class FakeModelGateway implements ModelGateway {
  private readonly responses: readonly ModelGatewayRawResult[]
  private cursor = 0

  constructor(options: FakeModelGatewayOptions) {
    if (!Array.isArray(options.responses) || options.responses.length > MAX_ATTEMPTS)
      throw new RangeError("fake gateway responses are unbounded")
    this.responses = Object.freeze(
      options.responses.map((response) => parseModelGatewayResult(response)),
    )
  }

  get calls(): number {
    return this.cursor
  }

  complete(_request: ModelGatewayAttemptRequest): ModelGatewayRawResult {
    const response = this.responses[this.cursor++]
    return response ?? { ok: false, error: { code: "unavailable" } }
  }
}

export interface ReplayModelGatewayOptions {
  readonly replayId: string
  readonly responses: readonly ModelGatewayRawResult[]
}

/** Network-free deterministic gateway for a caller-owned, already prepared response sequence. */
export class ReplayModelGateway implements ModelGateway {
  readonly replayId: string
  private readonly responses: readonly ModelGatewayRawResult[]
  private cursor = 0

  constructor(options: ReplayModelGatewayOptions) {
    if (!TOKEN.test(options.replayId)) throw new TypeError("replay gateway id is invalid")
    if (!Array.isArray(options.responses) || options.responses.length > MAX_ATTEMPTS)
      throw new RangeError("replay gateway responses are unbounded")
    this.replayId = options.replayId
    this.responses = Object.freeze(
      options.responses.map((response) => parseModelGatewayResult(response)),
    )
  }

  get calls(): number {
    return this.cursor
  }

  complete(_request: ModelGatewayAttemptRequest): ModelGatewayRawResult {
    const response = this.responses[this.cursor++]
    return response ?? { ok: false, error: { code: "unavailable" } }
  }
}
