/**
 * Typed tool contracts.
 *
 * A tool is an owned effect seam for an agent. The contract carries the data shape, authority,
 * approval, idempotency, dimensionless cost, and sensitivity metadata that every adapter needs.
 * Adapters call {@link executeTool}; they do not reimplement admission.
 *
 * This module is deliberately token-only in its evidence and idempotency stores. It never persists
 * tool arguments, results, request bodies, or business values.
 */

import type { RequestBudget } from "./budget.ts"
import {
  defineExecutionPolicy,
  type ExecutionPolicy,
  type ExecutionPolicyAdapter,
} from "./execution-policy.ts"
import {
  type IdempotencyScope,
  validIdempotencyKey,
  validIdempotencyNamespace,
} from "./idempotency.ts"
import { validCapabilityId } from "./internal/capability-runtime.ts"
import {
  createRequestLedger,
  type EffectCost,
  normalizeEffectMetadata,
  type RequestLedger,
  type SealedEffectLedger,
} from "./ledger.ts"
import { reflectSchema } from "./reflection.ts"
import {
  type InferOutput,
  type StandardIssue,
  type StandardSchemaV1,
  validateStandard,
} from "./schema/standard.ts"
import { guardParsedValue, type ProtoPoisoning } from "./server/proto-guard.ts"

const TOOL_NAME = /^[a-z][a-z0-9._-]{0,63}$/
const MAX_EVIDENCE = 64
const DEFAULT_NAMESPACE = "tool"
const DEFAULT_CAPABILITY = "tool.execute"

export type ToolSensitivity = "public" | "internal" | "sensitive" | "secret"

export type ToolApprovalPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "required" }
  | { readonly kind: "threshold"; readonly level: number }

export type ToolApproval =
  | { readonly granted: true; readonly level?: number }
  | { readonly granted: false; readonly reason?: string }

export interface ToolAnnotations {
  readonly title?: string
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

export interface ToolIdempotencyPolicy<Input = unknown> {
  readonly scope: Exclude<IdempotencyScope, "none">
  /** Return an opaque bounded key. The key must not contain a request body or secret. */
  readonly key: (input: Input) => string | PromiseLike<string>
}

export interface ToolContractOptions<
  Input,
  Output,
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
> {
  readonly name: string
  readonly description: string
  readonly input: InputSchema
  readonly output: OutputSchema
  readonly capability?: string
  readonly approval?: ToolApprovalPolicy
  readonly idempotency?: ToolIdempotencyPolicy<Input>
  /** Dimensionless counters such as `{ calls: 1, ms: 20 }`; never prices. */
  readonly cost?: EffectCost
  readonly sensitivity?: ToolSensitivity
  readonly annotations?: ToolAnnotations
  readonly policy?: ExecutionPolicy
  readonly execute: (input: Input, context: ToolExecutionContext) => Output | PromiseLike<Output>
}

export interface ToolContract<Input = unknown, Output = unknown> {
  readonly name: string
  readonly description: string
  readonly input: StandardSchemaV1<unknown, Input>
  readonly output: StandardSchemaV1<unknown, Output>
  readonly capability: string
  readonly approval: ToolApprovalPolicy
  readonly idempotency?: ToolIdempotencyPolicy<Input>
  readonly cost?: EffectCost
  readonly sensitivity: ToolSensitivity
  readonly annotations: ToolAnnotations
  readonly policy?: ExecutionPolicy
  readonly execute: (input: Input, context: ToolExecutionContext) => Output | PromiseLike<Output>
}

export interface ToolExecutionContext {
  readonly effectId: string
  readonly signal: AbortSignal
  /** Wall-clock budget shared with the parent request, when an agent supplies one. */
  readonly deadline?: RequestBudget
  readonly dryRun: boolean
  readonly policy?: ExecutionPolicy
}

export interface ToolBudget {
  readonly consume: (cost: EffectCost | undefined) => boolean
  readonly snapshot: () => EffectCost
}

export interface CreateToolBudgetOptions {
  readonly limits: EffectCost
  readonly initial?: EffectCost
}

export function createToolBudget(options: CreateToolBudgetOptions): ToolBudget {
  const limits = normalizeCost(options.limits, "tool budget limits")
  const spent = normalizeCost(options.initial ?? {}, "tool budget initial")
  for (const [axis, value] of Object.entries(spent)) {
    if ((limits[axis] ?? 0) < value) {
      throw new RangeError(`tool budget: initial ${axis} exceeds its limit`)
    }
  }
  return {
    consume(cost) {
      const next = normalizeCost(cost ?? {}, "tool cost")
      for (const [axis, value] of Object.entries(next)) {
        if ((limits[axis] ?? 0) < (spent[axis] ?? 0) + value) return false
      }
      for (const [axis, value] of Object.entries(next)) spent[axis] = (spent[axis] ?? 0) + value
      return true
    },
    snapshot() {
      return Object.freeze({ ...spent })
    },
  }
}

export interface ToolIdempotencyBeginInput {
  readonly namespace: string
  readonly key: string
}

export type ToolIdempotencyBeginResult =
  | { readonly state: "new"; readonly reservation: string }
  | { readonly state: "duplicate" }
  | { readonly state: "in-flight" }
  | { readonly state: "capacity" }

export interface ToolIdempotencyStore {
  readonly durability?: "memory" | "durable"
  begin(
    input: ToolIdempotencyBeginInput,
  ): ToolIdempotencyBeginResult | PromiseLike<ToolIdempotencyBeginResult>
  complete(input: {
    readonly namespace: string
    readonly key: string
    readonly reservation: string
  }): boolean | PromiseLike<boolean>
  abandon(input: {
    readonly namespace: string
    readonly key: string
    readonly reservation: string
  }): boolean | PromiseLike<boolean>
}

interface ToolIdempotencyEntry {
  readonly reservation: string
  readonly expiresAt: number
  completed: boolean
}

export interface MemoryToolIdempotencyStoreOptions {
  readonly maxEntries?: number
  readonly ttlMs?: number
  readonly now?: () => number
}

export class MemoryToolIdempotencyStore implements ToolIdempotencyStore {
  readonly durability = "memory" as const
  private readonly entries = new Map<string, ToolIdempotencyEntry>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: MemoryToolIdempotencyStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000
    this.ttlMs = options.ttlMs ?? 86_400_000
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError("tool idempotency: maxEntries must be a positive safe integer")
    }
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new RangeError("tool idempotency: ttlMs must be a positive safe integer")
    }
  }

  begin(input: ToolIdempotencyBeginInput): ToolIdempotencyBeginResult {
    validateIdempotencyInput(input)
    const key = `${input.namespace.length}:${input.namespace}${input.key}`
    const existing = this.entries.get(key)
    const now = this.now()
    if (existing !== undefined && existing.expiresAt > now) {
      return { state: existing.completed ? "duplicate" : "in-flight" }
    }
    if (existing !== undefined) this.entries.delete(key)
    this.sweep()
    if (this.entries.size >= this.maxEntries) return { state: "capacity" }
    this.entries.set(key, {
      reservation: crypto.randomUUID(),
      expiresAt: now + this.ttlMs,
      completed: false,
    })
    return { state: "new", reservation: this.entries.get(key)!.reservation }
  }

  complete(input: {
    readonly namespace: string
    readonly key: string
    readonly reservation: string
  }): boolean {
    validateIdempotencyInput(input)
    const entry = this.entries.get(`${input.namespace.length}:${input.namespace}${input.key}`)
    if (
      entry === undefined ||
      entry.reservation !== input.reservation ||
      entry.expiresAt <= this.now()
    )
      return false
    entry.completed = true
    return true
  }

  abandon(input: {
    readonly namespace: string
    readonly key: string
    readonly reservation: string
  }): boolean {
    validateIdempotencyInput(input)
    const key = `${input.namespace.length}:${input.namespace}${input.key}`
    const entry = this.entries.get(key)
    if (entry === undefined || entry.reservation !== input.reservation || entry.completed)
      return false
    this.entries.delete(key)
    return true
  }

  sweep(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key)
  }
}

export type ToolEvidenceStage =
  | "input"
  | "capability"
  | "policy"
  | "approval"
  | "idempotency"
  | "budget"
  | "execution"
  | "output"

export type ToolEvidenceOutcome =
  | "passed"
  | "denied"
  | "failed"
  | "skipped"
  | "committed"
  | "dry-run"

export interface ToolEvidence {
  readonly seq: number
  readonly stage: ToolEvidenceStage
  readonly outcome: ToolEvidenceOutcome
  readonly code?: string
}

export interface ToolError {
  readonly code:
    | "input_invalid"
    | "capability_denied"
    | "execution_policy_unsatisfied"
    | "approval_required"
    | "approval_denied"
    | "idempotency_store_missing"
    | "idempotency_durability"
    | "idempotency_duplicate"
    | "idempotency_in_flight"
    | "idempotency_capacity"
    | "budget_exceeded"
    | "cancelled"
    | "execution_failed"
    | "output_invalid"
    | "ledger_failed"
  readonly stage: ToolEvidenceStage
  readonly issues?: readonly StandardIssue[]
}

export type ToolCallResult<Output> =
  | {
      readonly ok: true
      readonly output?: Output
      readonly dryRun: boolean
      readonly evidence: readonly ToolEvidence[]
      readonly ledger: SealedEffectLedger
    }
  | {
      readonly ok: false
      readonly dryRun: boolean
      readonly output?: undefined
      readonly error: ToolError
      readonly evidence: readonly ToolEvidence[]
      readonly ledger: SealedEffectLedger
    }

export interface ToolCallOptions {
  readonly effectId?: string
  readonly clock?: () => number
  readonly signal?: AbortSignal
  /** Wall-clock budget shared with the parent request, distinct from the cost `budget`. */
  readonly deadline?: RequestBudget
  readonly capabilities?: readonly string[]
  readonly approval?: ToolApproval
  readonly budget?: ToolBudget
  readonly idempotency?: ToolIdempotencyStore
  readonly namespace?: string
  readonly dryRun?: boolean
  readonly ledger?: RequestLedger
  readonly executionPolicy?: ExecutionPolicyAdapter
}

export function defineTool<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(
  options: ToolContractOptions<
    InferOutput<InputSchema>,
    InferOutput<OutputSchema>,
    InputSchema,
    OutputSchema
  >,
): ToolContract<InferOutput<InputSchema>, InferOutput<OutputSchema>> {
  if (typeof options !== "object" || options === null)
    throw new TypeError("tool contract: options must be an object")
  if (!TOOL_NAME.test(options.name))
    throw new TypeError(`tool contract: invalid name ${JSON.stringify(options.name)}`)
  if (typeof options.description !== "string" || options.description.trim() === "") {
    throw new TypeError("tool contract: description must not be empty")
  }
  if (!isStandardSchema(options.input) || !isStandardSchema(options.output)) {
    throw new TypeError("tool contract: input and output must implement Standard Schema")
  }
  if (options.capability !== undefined && !validCapabilityId(options.capability)) {
    throw new TypeError(`tool contract: invalid capability ${JSON.stringify(options.capability)}`)
  }
  const approval = validateApprovalPolicy(options.approval ?? { kind: "none" })
  const cost =
    options.cost === undefined ? undefined : normalizeEffectMetadata({ cost: options.cost }).cost
  const sensitivity = options.sensitivity ?? "internal"
  if (!isSensitivity(sensitivity)) throw new TypeError("tool contract: invalid sensitivity")
  const policy = options.policy === undefined ? undefined : defineExecutionPolicy(options.policy)
  if (options.idempotency !== undefined) validateIdempotencyPolicy(options.idempotency)
  if (typeof options.execute !== "function")
    throw new TypeError("tool contract: execute must be a function")
  return Object.freeze({
    name: options.name,
    description: options.description.trim(),
    input: options.input,
    output: options.output,
    capability: options.capability ?? `${DEFAULT_CAPABILITY}.${options.name}`,
    approval,
    ...(options.idempotency === undefined ? {} : { idempotency: options.idempotency }),
    ...(cost === undefined ? {} : { cost }),
    sensitivity,
    annotations: Object.freeze({ ...(options.annotations ?? {}) }),
    ...(policy === undefined ? {} : { policy }),
    execute: options.execute,
  })
}

export async function executeTool<Input, Output>(
  tool: ToolContract<Input, Output>,
  input: unknown,
  options: ToolCallOptions = {},
): Promise<ToolCallResult<Output>> {
  const signal = options.signal ?? new AbortController().signal
  const dryRun = options.dryRun === true
  const ledger =
    options.ledger ??
    createRequestLedger({
      method: "TOOL",
      path: `/${tool.name}`,
      declared: [tool.capability],
      chain: true,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    })
  const evidence: ToolEvidence[] = []
  const effectId = options.effectId ?? crypto.randomUUID()
  let reservation:
    | { readonly namespace: string; readonly key: string; readonly value: string }
    | undefined
  const record = (stage: ToolEvidenceStage, outcome: ToolEvidenceOutcome, code?: string): void => {
    if (evidence.length >= MAX_EVIDENCE) return
    evidence.push({ seq: evidence.length, stage, outcome, ...(code === undefined ? {} : { code }) })
  }
  const appendIntent = (): void => {
    ledger.append({
      capability: tool.capability,
      effectId,
      phase: "intent",
      target: `tool:${tool.name}`,
      ...(tool.cost === undefined ? {} : { cost: tool.cost }),
    })
  }
  type ToolCallOutcome =
    | { readonly ok: true; readonly dryRun: boolean; readonly output?: Output }
    | { readonly ok: false; readonly dryRun: boolean; readonly error: ToolError }
  const finish = async (result: ToolCallOutcome): Promise<ToolCallResult<Output>> => {
    try {
      if (result.ok) {
        ledger.append({
          capability: tool.capability,
          effectId,
          phase: "committed",
          target: `tool:${tool.name}`,
          ...(tool.cost === undefined ? {} : { cost: tool.cost }),
        })
      } else {
        ledger.append({
          capability: tool.capability,
          effectId,
          phase: "failed",
          target: `tool:${tool.name}`,
          ...(tool.cost === undefined ? {} : { cost: tool.cost }),
          error: { code: result.error.code },
        })
      }
      const sealed = await ledger.seal()
      return { ...result, evidence: Object.freeze([...evidence]), ledger: sealed }
    } catch {
      const fallback: ToolCallResult<Output> = {
        ok: false,
        dryRun,
        error: { code: "ledger_failed", stage: "execution" },
        evidence: Object.freeze([
          ...evidence,
          { seq: evidence.length, stage: "execution", outcome: "failed", code: "ledger_failed" },
        ]),
        ledger: await createRequestLedger({
          method: "TOOL",
          path: `/${tool.name}`,
          declared: [tool.capability],
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        }).seal(),
      }
      return fallback
    }
  }

  try {
    appendIntent()
    const validatedInput = await validateStandard(tool.input, input)
    if (!validatedInput.ok) {
      record("input", "denied", "input_invalid")
      return finish({
        ok: false,
        dryRun,
        error: { code: "input_invalid", stage: "input", issues: validatedInput.issues },
      })
    }
    record("input", "passed")

    if (signal.aborted) {
      record("capability", "denied", "cancelled")
      return finish({ ok: false, dryRun, error: { code: "cancelled", stage: "capability" } })
    }
    if (!hasCapability(options.capabilities, tool.capability)) {
      record("capability", "denied", "capability_denied")
      return finish({
        ok: false,
        dryRun,
        error: { code: "capability_denied", stage: "capability" },
      })
    }
    record("capability", "passed")

    if (tool.policy !== undefined) {
      if (
        !tool.policy.capabilityCeiling.includes(tool.capability) ||
        options.executionPolicy === undefined ||
        !(await options.executionPolicy.canSatisfy(tool.policy))
      ) {
        record("policy", "denied", "execution_policy_unsatisfied")
        return finish({
          ok: false,
          dryRun,
          error: { code: "execution_policy_unsatisfied", stage: "policy" },
        })
      }
      record("policy", "passed")
    }

    const approvalError = checkApproval(tool.approval, options.approval)
    if (approvalError !== undefined) {
      record("approval", "denied", approvalError)
      return finish({ ok: false, dryRun, error: { code: approvalError, stage: "approval" } })
    }
    record("approval", tool.approval.kind === "none" ? "skipped" : "passed")

    if (tool.idempotency !== undefined) {
      const namespace = options.namespace ?? DEFAULT_NAMESPACE
      if (!validIdempotencyNamespace(namespace)) {
        record("idempotency", "denied", "idempotency_store_missing")
        return finish({
          ok: false,
          dryRun,
          error: { code: "idempotency_store_missing", stage: "idempotency" },
        })
      }
      if (options.idempotency === undefined) {
        record("idempotency", "denied", "idempotency_store_missing")
        return finish({
          ok: false,
          dryRun,
          error: { code: "idempotency_store_missing", stage: "idempotency" },
        })
      }
      if (tool.idempotency.scope === "durable" && options.idempotency.durability !== "durable") {
        record("idempotency", "denied", "idempotency_durability")
        return finish({
          ok: false,
          dryRun,
          error: { code: "idempotency_durability", stage: "idempotency" },
        })
      }
      const key = await tool.idempotency.key(validatedInput.value)
      if (!validIdempotencyKey(key)) {
        record("idempotency", "denied", "idempotency_store_missing")
        return finish({
          ok: false,
          dryRun,
          error: { code: "idempotency_store_missing", stage: "idempotency" },
        })
      }
      const began = await options.idempotency.begin({ namespace, key })
      if (began.state !== "new") {
        const code =
          began.state === "duplicate"
            ? "idempotency_duplicate"
            : began.state === "in-flight"
              ? "idempotency_in_flight"
              : "idempotency_capacity"
        record("idempotency", "denied", code)
        return finish({ ok: false, dryRun, error: { code, stage: "idempotency" } })
      }
      reservation = { namespace, key, value: began.reservation }
    }
    record("idempotency", tool.idempotency === undefined ? "skipped" : "passed")

    if (options.budget !== undefined && !options.budget.consume(tool.cost)) {
      if (reservation !== undefined)
        await options.idempotency?.abandon(reservationInput(reservation))
      record("budget", "denied", "budget_exceeded")
      return finish({ ok: false, dryRun, error: { code: "budget_exceeded", stage: "budget" } })
    }
    record("budget", tool.cost === undefined ? "skipped" : "passed")

    if (signal.aborted) {
      if (reservation !== undefined)
        await options.idempotency?.abandon(reservationInput(reservation))
      record("execution", "denied", "cancelled")
      return finish({ ok: false, dryRun, error: { code: "cancelled", stage: "execution" } })
    }
    if (dryRun) {
      if (reservation !== undefined)
        await options.idempotency?.abandon(reservationInput(reservation))
      record("execution", "dry-run")
      return finish({ ok: true, dryRun })
    }
    const output = await tool.execute(validatedInput.value, {
      effectId,
      signal,
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      dryRun,
      ...(tool.policy === undefined ? {} : { policy: tool.policy }),
    })
    record("execution", "committed")
    const validatedOutput = await validateStandard(tool.output, output)
    if (!validatedOutput.ok) {
      // The executor has already run. Keep the reservation completed even when its return shape is
      // invalid, so a caller cannot retry and duplicate a side effect that may have committed.
      if (reservation !== undefined) {
        const completed = await options.idempotency?.complete(reservationInput(reservation))
        if (completed !== true) {
          record("idempotency", "failed", "idempotency_capacity")
          return finish({
            ok: false,
            dryRun,
            error: { code: "idempotency_capacity", stage: "idempotency" },
          })
        }
      }
      record("output", "failed", "output_invalid")
      return finish({
        ok: false,
        dryRun,
        error: { code: "output_invalid", stage: "output", issues: validatedOutput.issues },
      })
    }
    record("output", "passed")
    if (reservation !== undefined) {
      const completed = await options.idempotency?.complete(reservationInput(reservation))
      if (completed !== true) {
        record("idempotency", "failed", "idempotency_capacity")
        return finish({
          ok: false,
          dryRun,
          error: { code: "idempotency_capacity", stage: "idempotency" },
        })
      }
    }
    return finish({ ok: true, dryRun, output: validatedOutput.value })
  } catch (error) {
    if (reservation !== undefined) await options.idempotency?.abandon(reservationInput(reservation))
    const code = signal.aborted || isAbortError(error) ? "cancelled" : "execution_failed"
    record("execution", "failed", code)
    return finish({ ok: false, dryRun, error: { code, stage: "execution" } })
  }
}

export interface ToolHttpOptions extends Omit<ToolCallOptions, "signal" | "ledger"> {
  readonly method?: string
  /** Prototype-poisoning policy for the JSON request body - mirrors the server option (this
   * handler is standalone, so it carries its own). Default `"reject"`. */
  readonly protoPoisoning?: ProtoPoisoning
}

/**
 * Mount one contract behind a Web-standard handler. The handler accepts one JSON request body.
 * A body carrying a poisoned key (own `__proto__`, or `constructor.prototype`) is rejected with
 * the same `input_invalid` result as malformed JSON. The body is read unbounded - cap request
 * size at the platform/server mounting this handler.
 */
export function createToolHttpHandler<Input, Output>(
  tool: ToolContract<Input, Output>,
  options: ToolHttpOptions = {},
): (request: Request) => Promise<Response> {
  const method = (options.method ?? "POST").toUpperCase()
  const protoPoisoning = options.protoPoisoning ?? "reject"
  return async (request) => {
    if (request.method.toUpperCase() !== method) {
      return new Response(null, { status: 405, headers: { allow: method } })
    }
    let input: unknown
    try {
      input = guardParsedValue(await request.json(), protoPoisoning)
    } catch {
      return toolHttpResult({
        ok: false,
        dryRun: options.dryRun === true,
        error: { code: "input_invalid", stage: "input" },
        evidence: [],
        ledger: await createRequestLedger({
          method: "TOOL",
          path: `/${tool.name}`,
          declared: [tool.capability],
        }).seal(),
      })
    }
    const result = await executeTool(tool, input, { ...options, signal: request.signal })
    return toolHttpResult(result)
  }
}

export function toolHttpResult<Output>(result: ToolCallResult<Output>): Response {
  const body = JSON.stringify(
    result.ok
      ? { ok: true, output: result.output, dryRun: result.dryRun, evidence: result.evidence }
      : { ok: false, error: result.error, dryRun: result.dryRun, evidence: result.evidence },
  )
  const status = result.ok
    ? 200
    : result.error.code === "input_invalid"
      ? 422
      : result.error.code === "approval_required" ||
          result.error.code === "approval_denied" ||
          result.error.code === "capability_denied"
        ? 403
        : result.error.code === "budget_exceeded"
          ? 429
          : 500
  return new Response(body, { status, headers: { "content-type": "application/json" } })
}

export function toolInputJsonSchema<Input, Output>(
  tool: ToolContract<Input, Output>,
): Record<string, unknown> {
  const reflected = reflectSchema(tool.input).jsonSchema
  if (
    reflected !== undefined &&
    typeof reflected === "object" &&
    reflected !== null &&
    !Array.isArray(reflected)
  )
    return { ...reflected }
  return { type: "object", properties: {}, additionalProperties: false }
}

export type ToolAdapterResult<Output = unknown> =
  | {
      readonly ok: true
      readonly output?: Output
      readonly dryRun: boolean
      readonly evidence: readonly ToolEvidence[]
    }
  | {
      readonly ok: false
      readonly dryRun: boolean
      readonly error: ToolError
      readonly evidence: readonly ToolEvidence[]
    }

export interface ToolAdapter {
  readonly name: string
  call(input: unknown, options?: ToolCallOptions): Promise<ToolAdapterResult>
}

export interface ToolConformanceResult {
  readonly adapter: string
  readonly checks: readonly string[]
}

/** Shared conformance assertions for adapters. It intentionally checks only public, token-only behavior. */
export async function runToolContractConformance(
  adapter: ToolAdapter,
  options: {
    readonly input: unknown
    readonly capability: string
    readonly approval: ToolApproval
    readonly dryRun: ToolCallOptions
  },
): Promise<ToolConformanceResult> {
  if (typeof adapter.call !== "function")
    throw new TypeError("tool conformance: adapter must be callable")
  const checks: string[] = []
  const denied = await adapter.call(options.input, { capabilities: [] })
  if (denied.ok || denied.error.code !== "capability_denied")
    throw new Error("tool conformance: capability denial failed")
  checks.push("capability denial")
  const pending = await adapter.call(options.input, {
    capabilities: [options.capability],
    approval: options.approval,
  })
  if (!pending.ok && pending.error.code === "approval_required")
    throw new Error("tool conformance: approval was not supplied")
  checks.push("approval admission")
  const dry = await adapter.call(options.input, {
    capabilities: [options.capability],
    approval: options.approval,
    ...options.dryRun,
    dryRun: true,
  })
  if (!dry.ok || !dry.dryRun || dry.evidence.every((item) => item.outcome !== "dry-run"))
    throw new Error("tool conformance: dry-run failed")
  checks.push("dry-run")
  return Object.freeze({ adapter: adapter.name, checks: Object.freeze(checks) })
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (value === null || typeof value !== "object") return false
  const standard = (value as { readonly [key: string]: unknown })["~standard"]
  return (
    standard !== null &&
    typeof standard === "object" &&
    (standard as { readonly version?: unknown }).version === 1 &&
    typeof (standard as { readonly validate?: unknown }).validate === "function"
  )
}

function validateApprovalPolicy(policy: ToolApprovalPolicy): ToolApprovalPolicy {
  if (policy.kind === "none" || policy.kind === "required")
    return Object.freeze({ kind: policy.kind })
  if (policy.kind === "threshold" && Number.isSafeInteger(policy.level) && policy.level > 0)
    return Object.freeze({ kind: "threshold", level: policy.level })
  throw new TypeError("tool contract: approval policy is invalid")
}

function validateIdempotencyPolicy<Input>(policy: ToolIdempotencyPolicy<Input>): void {
  if (policy.scope !== "request" && policy.scope !== "durable")
    throw new TypeError("tool contract: idempotency scope is invalid")
  if (typeof policy.key !== "function")
    throw new TypeError("tool contract: idempotency key must be a function")
}

function validateIdempotencyInput(input: {
  readonly namespace: string
  readonly key: string
}): void {
  if (!validIdempotencyNamespace(input.namespace) || !validIdempotencyKey(input.key))
    throw new TypeError("tool idempotency: namespace/key is invalid")
}

function reservationInput(input: {
  readonly namespace: string
  readonly key: string
  readonly value: string
}): { readonly namespace: string; readonly key: string; readonly reservation: string } {
  return { namespace: input.namespace, key: input.key, reservation: input.value }
}

function checkApproval(
  policy: ToolApprovalPolicy,
  approval: ToolApproval | undefined,
): ToolError["code"] | undefined {
  if (policy.kind === "none") return undefined
  if (approval === undefined) return "approval_required"
  if (!approval.granted) return "approval_denied"
  if (policy.kind === "threshold" && (approval.level ?? 0) < policy.level) return "approval_denied"
  return undefined
}

function hasCapability(values: readonly string[] | undefined, required: string): boolean {
  if (!Array.isArray(values)) return false
  for (const value of values)
    if (typeof value !== "string" || !validCapabilityId(value)) return false
  return values.includes(required)
}

function normalizeCost(value: EffectCost, label: string): Record<string, number> {
  try {
    const normalized = normalizeEffectMetadata({ cost: value }).cost
    return { ...(normalized ?? {}) }
  } catch (error) {
    throw new TypeError(`${label}: ${error instanceof Error ? error.message : "invalid cost"}`)
  }
}

function isSensitivity(value: string): value is ToolSensitivity {
  return value === "public" || value === "internal" || value === "sensitive" || value === "secret"
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
