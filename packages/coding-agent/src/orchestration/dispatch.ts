/**
 * Evidence-only dispatch contracts for at-least-once run execution.
 *
 * These values deliberately contain no job payload, tenant state, credentials, retention policy,
 * error message, or tool/model data. A durable operated adapter may implement the ports, but the
 * public reference adapters are disposable and keep only identifiers, digests, counters, and
 * lifecycle evidence. Delivery is at-least-once; callers make effects idempotent with the key
 * derived below and prove completion before a recovered worker skips the effect.
 */

import { sha256HexOf } from "./hash.ts"

export const RUN_DISPATCH_VERSION = 1 as const
export const DISPATCH_JOB_NAME = "nifra.agent.run-node"
export const MAX_DISPATCH_STRING = 256
export const MAX_DISPATCH_ATTEMPTS = 16

export type DispatchBoundary = "before-effect" | "after-effect"
export type DispatchState =
  | "queued"
  | "leased"
  | "checkpointed"
  | "retrying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "dead-lettered"

export type DispatchResultCode =
  | "accepted"
  | "stale_lease"
  | "cancelled"
  | "terminal"
  | "invalid_checkpoint"
  | "idempotency_required"

export interface InjectedClock {
  readonly now: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
}

export const systemClock: InjectedClock = Object.freeze({ now: () => Date.now() })

/** A queued node identity. It is safe to persist and safe to show in evidence. */
export interface RunDispatch {
  readonly version: typeof RUN_DISPATCH_VERSION
  readonly dispatchId: string
  readonly runId: string
  readonly planDigest: string
  readonly nodeId: string
  readonly maxAttempts: number
  readonly notBefore: number
}

/** A lease with a generation. A completion from any older generation is rejected. */
export interface RunLease {
  readonly version: typeof RUN_DISPATCH_VERSION
  readonly leaseId: string
  readonly dispatch: RunDispatch
  /** Logical attempt is stable across duplicate delivery while the same attempt is unresolved. */
  readonly attempt: number
  readonly generation: number
  readonly leasedAt: number
  readonly leaseUntil: number
  readonly scheduleToken: string
  readonly idempotencyKey: string
}

/** A safe boundary checkpoint. It never contains a result or effect payload. */
export interface RunCheckpoint {
  readonly version: typeof RUN_DISPATCH_VERSION
  readonly dispatchId: string
  readonly runId: string
  readonly nodeId: string
  readonly attempt: number
  readonly generation: number
  readonly boundary: DispatchBoundary
  readonly idempotencyKey: string
  readonly at: number
  readonly scheduleToken: string
}

/** A terminal or transitional record suitable for a public evidence sink. */
export interface RunDispatchEvidence {
  readonly version: typeof RUN_DISPATCH_VERSION
  readonly dispatchId: string
  readonly runId: string
  readonly nodeId: string
  readonly state: DispatchState
  readonly attempt: number
  readonly generation: number
  readonly at: number
  readonly scheduleToken: string
  readonly idempotencyKey: string
  readonly code?: string
}

export interface DispatchWriteResult {
  readonly ok: boolean
  readonly code: DispatchResultCode
}

export interface DispatchInspection {
  readonly dispatch: RunDispatch
  readonly state: DispatchState
  readonly attempt: number
  readonly generation: number
  readonly checkpoint?: RunCheckpoint
  readonly evidence: readonly RunDispatchEvidence[]
}

export interface RunDispatchStore {
  enqueue(dispatch: RunDispatch): void | Promise<void>
  lease(now: number, limit: number, leaseMs: number): RunLease[] | Promise<RunLease[]>
  checkpoint(
    lease: RunLease,
    checkpoint: RunCheckpoint,
  ): DispatchWriteResult | Promise<DispatchWriteResult>
  complete(
    lease: RunLease,
    evidence?: RunDispatchEvidence,
  ): DispatchWriteResult | Promise<DispatchWriteResult>
  retry(
    lease: RunLease,
    runAt: number,
    code: string,
  ): DispatchWriteResult | Promise<DispatchWriteResult>
  deadLetter(lease: RunLease, code: string): DispatchWriteResult | Promise<DispatchWriteResult>
  cancel(runId: string, code?: string): number | Promise<number>
  inspect(
    dispatchId: string,
  ): DispatchInspection | undefined | Promise<DispatchInspection | undefined>
}

/**
 * Optional operated-depth handoff. The context is intentionally opaque: the public package does not
 * model tenants, rows, RLS policy text, retention periods, credentials, workers, or fleet topology.
 * A private adapter supplies those controls and still implements the evidence-only store port above.
 */
export interface DurableDispatchAdapter<OpaqueContext = unknown> extends RunDispatchStore {
  authorize(
    context: OpaqueContext,
    operation: "enqueue" | "lease" | "inspect" | "settle",
  ): boolean | Promise<boolean>
  enforceDataLayerPolicy(
    context: OpaqueContext,
    operation: "read" | "write",
  ): boolean | Promise<boolean>
  retainEvidence(context: OpaqueContext, evidence: RunDispatchEvidence): void | Promise<void>
  reconcile(context: OpaqueContext, dispatchId: string): void | Promise<void>
  workerHealth(
    context: OpaqueContext,
  ): "ready" | "draining" | "unavailable" | Promise<"ready" | "draining" | "unavailable">
}

const DIGEST = /^[0-9a-f]{64}$/
const TOKEN = /^[A-Za-z0-9._:-]{1,256}$/
const FORBIDDEN = new Set([
  "prompt",
  "message",
  "text",
  "input",
  "output",
  "arguments",
  "body",
  "response",
  "secret",
  "credential",
  "diagnostic",
  "stack",
  "content",
  "transcript",
  "artifact",
])

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${where} must be an object`)
  return value as Record<string, unknown>
}

function rejectKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key.toLowerCase()))
      throw new TypeError(`${where} contains forbidden field '${key}'`)
    if (!allowed.has(key)) throw new TypeError(`${where} contains unknown field '${key}'`)
  }
}

function boundedString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DISPATCH_STRING)
    throw new TypeError(`${name} must be a non-empty bounded string`)
  return value
}

function digest(value: unknown, name: string): string {
  const text = boundedString(value, name)
  if (!DIGEST.test(text)) throw new TypeError(`${name} must be a lowercase sha256 digest`)
  return text
}

function token(value: unknown, name: string): string {
  const text = boundedString(value, name)
  if (!TOKEN.test(text)) throw new TypeError(`${name} must be an opaque schedule token`)
  return text
}

function nonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative safe integer`)
  return value
}

function attempts(value: unknown): number {
  const result = nonNegative(value, "maxAttempts")
  if (result < 1 || result > MAX_DISPATCH_ATTEMPTS)
    throw new RangeError(`maxAttempts must be between 1 and ${MAX_DISPATCH_ATTEMPTS}`)
  return result
}

const DISPATCH_KEYS = new Set([
  "version",
  "dispatchId",
  "runId",
  "planDigest",
  "nodeId",
  "maxAttempts",
  "notBefore",
])

/** Parse a dispatch identity and reject content or undeclared fields. */
export function parseRunDispatch(value: unknown): RunDispatch {
  const input = record(value, "run dispatch")
  rejectKeys(input, DISPATCH_KEYS, "run dispatch")
  if (input.version !== RUN_DISPATCH_VERSION)
    throw new TypeError("run dispatch.version is unsupported")
  return Object.freeze({
    version: RUN_DISPATCH_VERSION,
    dispatchId: token(input.dispatchId, "dispatchId"),
    runId: token(input.runId, "runId"),
    planDigest: digest(input.planDigest, "planDigest"),
    nodeId: token(input.nodeId, "nodeId"),
    maxAttempts: attempts(input.maxAttempts),
    notBefore: nonNegative(input.notBefore, "notBefore"),
  })
}

const LEASE_KEYS = new Set([
  "version",
  "leaseId",
  "dispatch",
  "attempt",
  "generation",
  "leasedAt",
  "leaseUntil",
  "scheduleToken",
  "idempotencyKey",
])

export function parseRunLease(value: unknown): RunLease {
  const input = record(value, "run lease")
  rejectKeys(input, LEASE_KEYS, "run lease")
  if (input.version !== RUN_DISPATCH_VERSION)
    throw new TypeError("run lease.version is unsupported")
  const attempt = attempts(input.attempt)
  const generation = nonNegative(input.generation, "generation")
  return Object.freeze({
    version: RUN_DISPATCH_VERSION,
    leaseId: token(input.leaseId, "leaseId"),
    dispatch: parseRunDispatch(input.dispatch),
    attempt,
    generation,
    leasedAt: nonNegative(input.leasedAt, "leasedAt"),
    leaseUntil: nonNegative(input.leaseUntil, "leaseUntil"),
    scheduleToken: token(input.scheduleToken, "scheduleToken"),
    idempotencyKey: token(input.idempotencyKey, "idempotencyKey"),
  })
}

const CHECKPOINT_KEYS = new Set([
  "version",
  "dispatchId",
  "runId",
  "nodeId",
  "attempt",
  "generation",
  "boundary",
  "idempotencyKey",
  "at",
  "scheduleToken",
])

export function parseRunCheckpoint(value: unknown): RunCheckpoint {
  const input = record(value, "run checkpoint")
  rejectKeys(input, CHECKPOINT_KEYS, "run checkpoint")
  if (input.version !== RUN_DISPATCH_VERSION)
    throw new TypeError("run checkpoint.version is unsupported")
  const boundary = input.boundary
  if (boundary !== "before-effect" && boundary !== "after-effect")
    throw new TypeError("run checkpoint.boundary is invalid")
  return Object.freeze({
    version: RUN_DISPATCH_VERSION,
    dispatchId: token(input.dispatchId, "dispatchId"),
    runId: token(input.runId, "runId"),
    nodeId: token(input.nodeId, "nodeId"),
    attempt: attempts(input.attempt),
    generation: nonNegative(input.generation, "generation"),
    boundary,
    idempotencyKey: token(input.idempotencyKey, "idempotencyKey"),
    at: nonNegative(input.at, "at"),
    scheduleToken: token(input.scheduleToken, "scheduleToken"),
  })
}

const EVIDENCE_KEYS = new Set([
  "version",
  "dispatchId",
  "runId",
  "nodeId",
  "state",
  "attempt",
  "generation",
  "at",
  "scheduleToken",
  "idempotencyKey",
  "code",
])

const STATES: ReadonlySet<string> = new Set([
  "queued",
  "leased",
  "checkpointed",
  "retrying",
  "succeeded",
  "failed",
  "cancelled",
  "dead-lettered",
])

export function parseRunDispatchEvidence(value: unknown): RunDispatchEvidence {
  const input = record(value, "run dispatch evidence")
  rejectKeys(input, EVIDENCE_KEYS, "run dispatch evidence")
  if (input.version !== RUN_DISPATCH_VERSION)
    throw new TypeError("run dispatch evidence.version is unsupported")
  if (typeof input.state !== "string" || !STATES.has(input.state))
    throw new TypeError("run dispatch evidence.state is invalid")
  return Object.freeze({
    version: RUN_DISPATCH_VERSION,
    dispatchId: token(input.dispatchId, "dispatchId"),
    runId: token(input.runId, "runId"),
    nodeId: token(input.nodeId, "nodeId"),
    state: input.state as DispatchState,
    attempt: attempts(input.attempt),
    generation: nonNegative(input.generation, "generation"),
    at: nonNegative(input.at, "at"),
    scheduleToken: token(input.scheduleToken, "scheduleToken"),
    idempotencyKey: token(input.idempotencyKey, "idempotencyKey"),
    ...(input.code === undefined ? {} : { code: token(input.code, "code") }),
  })
}

/** Stable key for one logical node attempt. Duplicate delivery uses the same boundary number. */
export function deriveRunIdempotencyKey(
  planDigest: string,
  runId: string,
  nodeId: string,
  logicalAttemptBoundary: number,
): Promise<string> {
  const plan = digest(planDigest, "planDigest")
  const run = token(runId, "runId")
  const node = token(nodeId, "nodeId")
  const attempt = attempts(logicalAttemptBoundary)
  return sha256HexOf(`${plan}\u0000${run}\u0000${node}\u0000${attempt}`)
}

/** Create a parsed dispatch identity before handing it to any adapter. */
export function createRunDispatch(input: Omit<RunDispatch, "version">): RunDispatch {
  return parseRunDispatch({ version: RUN_DISPATCH_VERSION, ...input })
}
