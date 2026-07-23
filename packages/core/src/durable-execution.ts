/**
 * Durable capability execution primitives. This subpath is opt-in so the bare HTTP runtime stays
 * lean. Approval and journal records are token-only. Saga input, results, and compensation arguments
 * intentionally live only in the caller-supplied durable saga store — never in the effect ledger or
 * telemetry — and production stores should encrypt them according to the application's data policy.
 */

import { type EffectLifecycleObserver, emitEffectLifecycle } from "./effect-lifecycle.ts"
import { createEffectScope } from "./effect-scope.ts"
import type {
  CapabilityApprovalGate,
  CapabilityExecutionIdentity,
  CapabilityExecutionJournal,
} from "./internal/capability-runtime.ts"
import { validCapabilityId } from "./internal/capability-runtime.ts"
import { safeEqual } from "./internal/safe-equal.ts"

export type { CapabilityApprovalGate, CapabilityExecutionIdentity, CapabilityExecutionJournal }

const TOKEN = /^[!-~]+$/
const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function assertToken(value: string, label: string, maxLength = 255): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !TOKEN.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded printable token`)
  }
}

function assertPositiveMs(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${label} must be a positive safe integer`)
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a non-negative safe integer timestamp`)
}

function readClock(clock: () => number, label: string): number {
  const value = clock()
  assertTimestamp(value, label)
  return value
}

function addDuration(timestamp: number, duration: number, label: string): number {
  const result = timestamp + duration
  assertTimestamp(result, label)
  return result
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new ApprovalTokenInvalidError()
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=")
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new ApprovalTokenInvalidError()
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function sha256(value: string): Promise<string> {
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
  )
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

// -------------------------------------------------------------------------------------------------
// Durable effect journal + reconciliation

export type DurableEffectState = "admission" | "executing" | "committed" | "failed" | "unknown"

export interface ReconciliationScanOptions<State extends string> {
  readonly states: readonly State[]
  readonly updatedBefore?: number
  readonly cursor?: string
  readonly limit: number
}

export interface ReconciliationScanPage<Record> {
  readonly records: readonly Record[]
  readonly cursor?: string
}

export interface ReconciliationPage<Finding> {
  readonly findings: readonly Finding[]
  readonly cursor?: string
}

export interface DurableEffectRecord {
  readonly effectId: string
  readonly capability: string
  readonly target?: string
  readonly digest?: string
  readonly tenantId?: string
  readonly principalId?: string
  readonly state: DurableEffectState
  readonly createdAt: number
  readonly updatedAt: number
  readonly errorCode?: string
  readonly version: number
}

export interface DurableEffectStore {
  readonly durability?: "memory" | "durable"
  create(record: DurableEffectRecord): boolean | Promise<boolean>
  get(effectId: string): DurableEffectRecord | undefined | Promise<DurableEffectRecord | undefined>
  /** Atomic compare-and-set; exactly one caller may advance the supplied `version` and `from` state. */
  transition(input: {
    readonly effectId: string
    readonly version: number
    readonly from: DurableEffectState
    readonly to: DurableEffectState
    readonly updatedAt: number
    readonly errorCode?: string
  }): boolean | Promise<boolean>
  /** Bounded operational scan. Transition-only stores do not need to implement reconciliation. */
  scan?(
    input: ReconciliationScanOptions<DurableEffectState>,
  ):
    | ReconciliationScanPage<DurableEffectRecord>
    | Promise<ReconciliationScanPage<DurableEffectRecord>>
  /** @deprecated Compatibility fallback; production reconciliation should implement `scan`. */
  list?(): readonly DurableEffectRecord[] | Promise<readonly DurableEffectRecord[]>
}

export class DurableEffectTransitionError extends Error {
  constructor(
    public readonly effectId: string,
    public readonly transition: string,
  ) {
    super(`durable effect ${effectId}: ${transition} transition was rejected`)
    this.name = "DurableEffectTransitionError"
  }
}

export interface DurableEffectJournalOptions {
  readonly store: DurableEffectStore
  readonly now?: () => number
  /** Tests/local development only. Production journals require `store.durability === "durable"`. */
  readonly allowMemoryStore?: boolean
}

export function createDurableEffectJournal(
  options: DurableEffectJournalOptions,
): CapabilityExecutionJournal {
  if (options.store.durability !== "durable" && options.allowMemoryStore !== true) {
    throw new TypeError('durable effect journal requires store.durability === "durable"')
  }
  const clock = options.now ?? Date.now
  const now = (): number => readClock(clock, "durable effect clock")

  const current = async (effectId: string): Promise<DurableEffectRecord> => {
    assertToken(effectId, "durable effect id", 64)
    const record = await options.store.get(effectId)
    if (record === undefined) throw new DurableEffectTransitionError(effectId, "missing")
    if (
      record.effectId !== effectId ||
      !validCapabilityId(record.capability) ||
      !["admission", "executing", "committed", "failed", "unknown"].includes(record.state) ||
      !Number.isSafeInteger(record.version) ||
      record.version < 1
    ) {
      throw new TypeError(`durable effect ${effectId}: store returned an invalid record`)
    }
    assertTimestamp(record.createdAt, "durable effect createdAt")
    assertTimestamp(record.updatedAt, "durable effect updatedAt")
    if (record.createdAt > record.updatedAt)
      throw new TypeError(`durable effect ${effectId}: updatedAt precedes createdAt`)
    if (record.target !== undefined) assertToken(record.target, "stored durable effect target", 128)
    if (record.digest !== undefined && !/^[0-9a-f]{64}$/u.test(record.digest))
      throw new TypeError(`durable effect ${effectId}: store returned an invalid digest`)
    if (record.tenantId !== undefined)
      assertToken(record.tenantId, "stored durable effect tenantId")
    if (record.principalId !== undefined)
      assertToken(record.principalId, "stored durable effect principalId")
    if ((record.tenantId === undefined) !== (record.principalId === undefined))
      throw new TypeError(`durable effect ${effectId}: store returned a partial identity`)
    if (record.errorCode !== undefined && !ERROR_CODE.test(record.errorCode))
      throw new TypeError(`durable effect ${effectId}: store returned an invalid error code`)
    return record
  }
  const transition = async (
    effectId: string,
    from: DurableEffectState,
    to: DurableEffectState,
    errorCode?: string,
  ): Promise<void> => {
    const record = await current(effectId)
    if (record.state !== from) throw new DurableEffectTransitionError(effectId, `${from}->${to}`)
    const accepted = await options.store.transition({
      effectId,
      version: record.version,
      from,
      to,
      updatedAt: now(),
      ...(errorCode === undefined ? {} : { errorCode }),
    })
    if (!accepted) throw new DurableEffectTransitionError(effectId, `${from}->${to}`)
  }

  const journal: CapabilityExecutionJournal = {
    async intent(input) {
      assertToken(input.effectId, "durable effect id", 64)
      if (!validCapabilityId(input.capability))
        throw new TypeError("durable effect capability is invalid")
      if (input.target !== undefined) assertToken(input.target, "durable effect target", 128)
      if (input.digest !== undefined && !/^[0-9a-f]{64}$/u.test(input.digest))
        throw new TypeError("durable effect digest is invalid")
      if (input.identity !== undefined) {
        assertToken(input.identity.tenantId, "durable effect tenantId")
        assertToken(input.identity.principalId, "durable effect principalId")
      }
      const at = now()
      const accepted = await options.store.create(
        Object.freeze({
          effectId: input.effectId,
          capability: input.capability,
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.digest === undefined ? {} : { digest: input.digest }),
          ...(input.identity === undefined
            ? {}
            : { tenantId: input.identity.tenantId, principalId: input.identity.principalId }),
          state: "admission" as const,
          createdAt: at,
          updatedAt: at,
          version: 1,
        }),
      )
      if (!accepted) throw new DurableEffectTransitionError(input.effectId, "create")
    },
    async executing(effectId) {
      await transition(effectId, "admission", "executing")
    },
    async committed(effectId) {
      await transition(effectId, "executing", "committed")
    },
    async failed(effectId, input) {
      if (!ERROR_CODE.test(input.errorCode))
        throw new TypeError("durable effect errorCode is invalid")
      const record = await current(effectId)
      const to = input.began ? "unknown" : "failed"
      const accepted = await options.store.transition({
        effectId,
        version: record.version,
        from: record.state,
        to,
        updatedAt: now(),
        errorCode: input.errorCode,
      })
      if (!accepted) throw new DurableEffectTransitionError(effectId, `${record.state}->${to}`)
    },
  }
  return Object.freeze(journal)
}

export class MemoryDurableEffectStore implements DurableEffectStore {
  readonly durability = "memory" as const
  private readonly records = new Map<string, DurableEffectRecord>()
  // Secondary index: effectIds grouped by state, so reconciliation scans only the requested (few,
  // non-terminal) states instead of walking every retained record. See {@link indexedScan}.
  private readonly byState = new Map<DurableEffectState, Set<string>>()

  create(record: DurableEffectRecord): boolean {
    if (this.records.has(record.effectId)) return false
    this.records.set(record.effectId, Object.freeze(cloneValue(record)))
    bucketAdd(this.byState, record.state, record.effectId)
    return true
  }

  get(effectId: string): DurableEffectRecord | undefined {
    const record = this.records.get(effectId)
    return record === undefined ? undefined : Object.freeze(cloneValue(record))
  }

  transition(input: Parameters<DurableEffectStore["transition"]>[0]): boolean {
    const current = this.records.get(input.effectId)
    if (current === undefined || current.version !== input.version || current.state !== input.from)
      return false
    this.records.set(
      input.effectId,
      Object.freeze({
        ...current,
        state: input.to,
        updatedAt: input.updatedAt,
        version: current.version + 1,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      }),
    )
    bucketMove(this.byState, current.state, input.to, input.effectId)
    return true
  }

  list(): readonly DurableEffectRecord[] {
    return Object.freeze(
      [...this.records.values()].map((record) => Object.freeze(cloneValue(record))),
    )
  }

  scan(
    input: ReconciliationScanOptions<DurableEffectState>,
  ): ReconciliationScanPage<DurableEffectRecord> {
    return indexedScan(this.byState, (id) => this.records.get(id), input)
  }
}

export interface EffectReconciliationFinding {
  readonly effectId: string
  readonly capability: string
  readonly state: "incomplete" | "ambiguous"
  readonly updatedAt: number
}

const DEFAULT_RECONCILIATION_LIMIT = 100
const MAX_RECONCILIATION_LIMIT = 1_000

function reconciliationLimit(value = DEFAULT_RECONCILIATION_LIMIT): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RECONCILIATION_LIMIT) {
    throw new RangeError(`reconciliation limit must be between 1 and ${MAX_RECONCILIATION_LIMIT}`)
  }
  return value
}

function cursorOffset(cursor?: string): number {
  if (cursor === undefined) return 0
  if (!/^(?:0|[1-9][0-9]*)$/u.test(cursor)) throw new TypeError("invalid reconciliation cursor")
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset)) throw new TypeError("invalid reconciliation cursor")
  return offset
}

function memoryScan<
  Record extends { readonly state: State; readonly updatedAt: number },
  State extends string,
>(
  source: Iterable<Record>,
  input: ReconciliationScanOptions<State>,
): ReconciliationScanPage<Record> {
  const states = new Set(input.states)
  const offset = cursorOffset(input.cursor)
  const end = offset + input.limit
  const records: Record[] = []
  // Stream the source: skip the first `offset` eligible records, collect up to `limit`, and stop as
  // soon as one more eligible record proves a next page exists. Bounds allocation to the page and
  // avoids materializing the whole store when the page fills early. (An unindexed in-memory store still
  // walks its records to find sparse matches; a production store implements `scan()` as an indexed
  // query - state + updatedAt predicate, keyset cursor - instead of relying on this reference scan.)
  let seen = 0
  let more = false
  for (const record of source) {
    if (!states.has(record.state)) continue
    if (input.updatedBefore !== undefined && record.updatedAt > input.updatedBefore) continue
    if (seen >= end) {
      more = true
      break
    }
    if (seen >= offset) records.push(cloneValue(record))
    seen++
  }
  return Object.freeze({
    records: Object.freeze(records),
    ...(more ? { cursor: String(offset + records.length) } : {}),
  })
}

function bucketAdd<State extends string>(
  byState: Map<State, Set<string>>,
  state: State,
  id: string,
): void {
  let bucket = byState.get(state)
  if (bucket === undefined) {
    bucket = new Set()
    byState.set(state, bucket)
  }
  bucket.add(id)
}

function bucketMove<State extends string>(
  byState: Map<State, Set<string>>,
  from: State,
  to: State,
  id: string,
): void {
  if (from === to) return
  byState.get(from)?.delete(id)
  bucketAdd(byState, to, id)
}

/**
 * Paginate a state-bucketed in-memory index: walk only the requested states' buckets (each a Set of
 * ids in insertion order), resolve + `updatedBefore`-filter each record, and page by offset cursor.
 * O(sum of the requested buckets) instead of O(total records) - the store still retains terminal
 * records, but reconciliation never walks them. Matches {@link memoryScan}'s paging semantics.
 */
function indexedScan<Record extends { readonly updatedAt: number }, State extends string>(
  byState: Map<State, Set<string>>,
  resolve: (id: string) => Record | undefined,
  input: ReconciliationScanOptions<State>,
): ReconciliationScanPage<Record> {
  const offset = cursorOffset(input.cursor)
  const end = offset + input.limit
  const records: Record[] = []
  let seen = 0
  let more = false
  for (const state of new Set(input.states)) {
    if (more) break
    const bucket = byState.get(state)
    if (bucket === undefined) continue
    for (const id of bucket) {
      const record = resolve(id)
      if (record === undefined) continue
      if (input.updatedBefore !== undefined && record.updatedAt > input.updatedBefore) continue
      if (seen >= end) {
        more = true
        break
      }
      if (seen >= offset) records.push(cloneValue(record))
      seen++
    }
  }
  return Object.freeze({
    records: Object.freeze(records),
    ...(more ? { cursor: String(offset + records.length) } : {}),
  })
}

async function scanEffectRecords(
  store: DurableEffectStore,
  input: ReconciliationScanOptions<DurableEffectState>,
): Promise<ReconciliationScanPage<DurableEffectRecord>> {
  if (store.scan !== undefined) return await store.scan(input)
  if (store.list === undefined) throw new TypeError("effect store does not support reconciliation")
  return memoryScan(await store.list(), input)
}

export async function reconcileEffectsPage(
  store: DurableEffectStore,
  options: {
    readonly staleBefore: number
    readonly observer?: EffectLifecycleObserver
    readonly cursor?: string
    readonly limit?: number
  },
): Promise<ReconciliationPage<EffectReconciliationFinding>> {
  const findings: EffectReconciliationFinding[] = []
  const page = await scanEffectRecords(store, {
    states: ["admission", "executing", "unknown"],
    updatedBefore: options.staleBefore,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    limit: reconciliationLimit(options.limit),
  })
  for (const record of page.records) {
    if (!validCapabilityId(record.capability) || !/^[!-~]{1,64}$/u.test(record.effectId)) continue
    if (record.updatedAt > options.staleBefore) continue
    const state =
      record.state === "admission"
        ? "incomplete"
        : record.state === "executing" || record.state === "unknown"
          ? "ambiguous"
          : undefined
    if (state === undefined) continue
    findings.push(
      Object.freeze({
        effectId: record.effectId,
        capability: record.capability,
        state,
        updatedAt: record.updatedAt,
      }),
    )
    if (options.observer !== undefined) {
      emitEffectLifecycle([options.observer], {
        effectId: record.effectId,
        capability: record.capability,
        stage: "reconciliation",
        phase: state === "ambiguous" ? "ambiguous" : "failed",
        errorCode: state === "ambiguous" ? "effect_ambiguous" : "effect_incomplete",
      })
    }
  }
  return Object.freeze({
    findings: Object.freeze(findings),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  })
}

export async function reconcileEffects(
  store: DurableEffectStore,
  options: { readonly staleBefore: number; readonly observer?: EffectLifecycleObserver },
): Promise<readonly EffectReconciliationFinding[]> {
  const page = await reconcileEffectsPage(store, {
    ...options,
    limit: MAX_RECONCILIATION_LIMIT,
  })
  if (page.cursor !== undefined) {
    throw new RangeError(
      `effect reconciliation exceeds ${MAX_RECONCILIATION_LIMIT} records; use reconcileEffectsPage()`,
    )
  }
  return page.findings
}

// -------------------------------------------------------------------------------------------------
// Durable human approval with signed, single-use resume tokens

export type ApprovalState = "pending" | "approved" | "denied" | "consumed" | "expired"

export interface ApprovalRecord {
  readonly approvalId: string
  readonly effectId: string
  readonly capability: string
  readonly target?: string
  readonly digest?: string
  readonly tenantId: string
  readonly principalId: string
  readonly tokenHash: string
  readonly state: ApprovalState
  readonly createdAt: number
  readonly expiresAt: number
  readonly updatedAt: number
  readonly decidedBy?: string
  readonly version: number
}

export type ApprovalConsumeResult =
  | { readonly state: "consumed" }
  | {
      readonly state: "missing" | "pending" | "denied" | "expired" | "replay" | "binding" | "token"
    }

export interface ApprovalStore {
  readonly durability?: "memory" | "durable"
  create(record: ApprovalRecord): boolean | Promise<boolean>
  get(approvalId: string): ApprovalRecord | undefined | Promise<ApprovalRecord | undefined>
  decide(input: {
    readonly approvalId: string
    readonly tenantId: string
    readonly decision: "approved" | "denied"
    readonly decidedBy: string
    readonly now: number
  }): boolean | Promise<boolean>
  /**
   * Atomically validate binding/token/state and change `approved` to `consumed`. Two concurrent
   * callers with one token must yield exactly one `consumed` and one `replay` result.
   */
  consume(input: {
    readonly approvalId: string
    readonly tenantId: string
    readonly principalId: string
    readonly capability: string
    readonly target?: string
    readonly digest?: string
    readonly tokenHash: string
    readonly now: number
  }): ApprovalConsumeResult | Promise<ApprovalConsumeResult>
}

export class ApprovalRequiredError extends Error {
  readonly approvalId: string
  readonly effectId: string
  readonly resumeToken!: string
  readonly expiresAt: number

  constructor(approvalId: string, effectId: string, resumeToken: string, expiresAt: number) {
    super("capability approval is required")
    this.approvalId = approvalId
    this.effectId = effectId
    this.expiresAt = expiresAt
    Object.defineProperty(this, "resumeToken", {
      value: resumeToken,
      enumerable: false,
      configurable: false,
      writable: false,
    })
    this.name = "ApprovalRequiredError"
  }
}

export class ApprovalTokenInvalidError extends Error {
  constructor() {
    super("approval resume token is invalid")
    this.name = "ApprovalTokenInvalidError"
  }
}
export class ApprovalTokenExpiredError extends Error {
  constructor() {
    super("approval resume token has expired")
    this.name = "ApprovalTokenExpiredError"
  }
}
export class ApprovalTokenReplayError extends Error {
  constructor() {
    super("approval resume token has already been consumed")
    this.name = "ApprovalTokenReplayError"
  }
}
export class ApprovalBindingError extends Error {
  constructor() {
    super("approval resume token is bound to another tenant or principal")
    this.name = "ApprovalBindingError"
  }
}
export class ApprovalPendingError extends Error {
  constructor() {
    super("capability approval is still pending")
    this.name = "ApprovalPendingError"
  }
}
export class ApprovalDeniedError extends Error {
  constructor() {
    super("capability approval was denied")
    this.name = "ApprovalDeniedError"
  }
}

interface ResumeClaims {
  readonly v: 1
  readonly id: string
  readonly nonce: string
  readonly exp: number
}

export interface ApprovalCoordinator extends CapabilityApprovalGate {
  decide(input: {
    readonly approvalId: string
    readonly tenantId: string
    readonly decision: "approved" | "denied"
    readonly decidedBy: string
  }): Promise<void>
  get(approvalId: string): Promise<ApprovalRecord | undefined>
}

export interface ApprovalCoordinatorOptions {
  readonly store: ApprovalStore
  /** At least 32 random bytes, kept separately from the approval store. */
  readonly secret: Uint8Array
  readonly ttlMs?: number
  readonly now?: () => number
  /** Tests/local development only. Production approval records require a durable store. */
  readonly allowMemoryStore?: boolean
}

export function createApprovalCoordinator(
  options: ApprovalCoordinatorOptions,
): ApprovalCoordinator {
  if (options.store.durability !== "durable" && options.allowMemoryStore !== true) {
    throw new TypeError('approval coordinator requires store.durability === "durable"')
  }
  if (!(options.secret instanceof Uint8Array) || options.secret.byteLength < 32) {
    throw new TypeError("approval secret must contain at least 32 random bytes")
  }
  const secret = new Uint8Array(options.secret)
  const ttlMs = options.ttlMs ?? 15 * 60_000
  assertPositiveMs(ttlMs, "approval ttlMs")
  const clock = options.now ?? Date.now
  const now = (): number => readClock(clock, "approval clock")
  const key = crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ])

  const sign = async (claims: ResumeClaims): Promise<string> => {
    const payload = bytesToBase64Url(encoder.encode(JSON.stringify(claims)))
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", await key, encoder.encode(payload)),
    )
    return `v1.${payload}.${bytesToBase64Url(signature)}`
  }
  const verify = async (token: string): Promise<ResumeClaims> => {
    if (typeof token !== "string" || token.length > 2048) throw new ApprovalTokenInvalidError()
    const parts = token.split(".")
    if (parts.length !== 3 || parts[0] !== "v1") throw new ApprovalTokenInvalidError()
    const payload = parts[1] as string
    const valid = await crypto.subtle.verify(
      "HMAC",
      await key,
      base64UrlToBytes(parts[2] as string).buffer as ArrayBuffer,
      encoder.encode(payload),
    )
    if (!valid) throw new ApprovalTokenInvalidError()
    let claims: unknown
    try {
      claims = JSON.parse(decoder.decode(base64UrlToBytes(payload)))
    } catch {
      throw new ApprovalTokenInvalidError()
    }
    if (typeof claims !== "object" || claims === null) throw new ApprovalTokenInvalidError()
    const candidate = claims as Partial<ResumeClaims>
    if (
      candidate.v !== 1 ||
      typeof candidate.id !== "string" ||
      typeof candidate.nonce !== "string" ||
      !Number.isSafeInteger(candidate.exp)
    ) {
      throw new ApprovalTokenInvalidError()
    }
    assertToken(candidate.id, "approval id", 128)
    assertToken(candidate.nonce, "approval nonce", 128)
    if ((candidate.exp as number) <= now()) throw new ApprovalTokenExpiredError()
    return candidate as ResumeClaims
  }

  const coordinator: ApprovalCoordinator = {
    async authorize(input: Parameters<CapabilityApprovalGate["authorize"]>[0]) {
      if (input.signal.aborted) throw input.signal.reason
      assertToken(input.identity.tenantId, "approval tenantId")
      assertToken(input.identity.principalId, "approval principalId")
      if (input.resumeToken === undefined) {
        const approvalId = crypto.randomUUID()
        const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18)))
        const issuedAt = now()
        const expiresAt = addDuration(issuedAt, ttlMs, "approval expiry")
        const resumeToken = await sign({ v: 1, id: approvalId, nonce, exp: expiresAt })
        const accepted = await options.store.create(
          Object.freeze({
            approvalId,
            effectId: input.effectId,
            capability: input.capability,
            ...(input.target === undefined ? {} : { target: input.target }),
            ...(input.digest === undefined ? {} : { digest: input.digest }),
            tenantId: input.identity.tenantId,
            principalId: input.identity.principalId,
            tokenHash: await sha256(resumeToken),
            state: "pending" as const,
            createdAt: issuedAt,
            expiresAt,
            updatedAt: issuedAt,
            version: 1,
          }),
        )
        if (!accepted) throw new Error("approval store rejected a unique approval id")
        throw new ApprovalRequiredError(approvalId, input.effectId, resumeToken, expiresAt)
      }
      const claims = await verify(input.resumeToken)
      const consumed = await options.store.consume({
        approvalId: claims.id,
        tenantId: input.identity.tenantId,
        principalId: input.identity.principalId,
        capability: input.capability,
        ...(input.target === undefined ? {} : { target: input.target }),
        ...(input.digest === undefined ? {} : { digest: input.digest }),
        tokenHash: await sha256(input.resumeToken),
        now: now(),
      })
      if (consumed.state === "consumed") return
      if (consumed.state === "replay") throw new ApprovalTokenReplayError()
      if (consumed.state === "binding") throw new ApprovalBindingError()
      if (consumed.state === "expired") throw new ApprovalTokenExpiredError()
      if (consumed.state === "pending") throw new ApprovalPendingError()
      if (consumed.state === "denied") throw new ApprovalDeniedError()
      throw new ApprovalTokenInvalidError()
    },
    async decide(input: Parameters<ApprovalCoordinator["decide"]>[0]) {
      assertToken(input.approvalId, "approval id", 128)
      assertToken(input.tenantId, "approval tenantId")
      assertToken(input.decidedBy, "approval decidedBy")
      const accepted = await options.store.decide({ ...input, now: now() })
      if (!accepted) throw new Error("approval decision rejected")
    },
    async get(approvalId: string) {
      assertToken(approvalId, "approval id", 128)
      return await options.store.get(approvalId)
    },
  }
  return Object.freeze(coordinator)
}

export class MemoryApprovalStore implements ApprovalStore {
  readonly durability = "memory" as const
  private readonly records = new Map<string, ApprovalRecord>()

  create(record: ApprovalRecord): boolean {
    if (this.records.has(record.approvalId)) return false
    this.records.set(record.approvalId, Object.freeze(cloneValue(record)))
    return true
  }
  get(approvalId: string): ApprovalRecord | undefined {
    const record = this.records.get(approvalId)
    return record === undefined ? undefined : Object.freeze(cloneValue(record))
  }
  decide(input: Parameters<ApprovalStore["decide"]>[0]): boolean {
    const record = this.records.get(input.approvalId)
    if (
      record === undefined ||
      record.tenantId !== input.tenantId ||
      record.state !== "pending" ||
      record.expiresAt <= input.now
    )
      return false
    this.records.set(
      input.approvalId,
      Object.freeze({
        ...record,
        state: input.decision,
        decidedBy: input.decidedBy,
        updatedAt: input.now,
        version: record.version + 1,
      }),
    )
    return true
  }
  consume(input: Parameters<ApprovalStore["consume"]>[0]): ApprovalConsumeResult {
    const record = this.records.get(input.approvalId)
    if (record === undefined) return { state: "missing" }
    if (
      record.tenantId !== input.tenantId ||
      record.principalId !== input.principalId ||
      record.capability !== input.capability ||
      record.target !== input.target ||
      !safeEqual(record.digest, input.digest)
    )
      return { state: "binding" }
    if (!safeEqual(record.tokenHash, input.tokenHash)) return { state: "token" }
    if (record.state === "consumed") return { state: "replay" }
    if (record.expiresAt <= input.now || record.state === "expired") {
      if (record.state !== "expired")
        this.records.set(
          input.approvalId,
          Object.freeze({
            ...record,
            state: "expired",
            updatedAt: input.now,
            version: record.version + 1,
          }),
        )
      return { state: "expired" }
    }
    if (record.state === "pending") return { state: "pending" }
    if (record.state === "denied") return { state: "denied" }
    if (record.state !== "approved") return { state: "token" }
    this.records.set(
      input.approvalId,
      Object.freeze({
        ...record,
        state: "consumed",
        updatedAt: input.now,
        version: record.version + 1,
      }),
    )
    return { state: "consumed" }
  }
  list(): readonly ApprovalRecord[] {
    return Object.freeze(
      [...this.records.values()].map((record) => Object.freeze(cloneValue(record))),
    )
  }
}

// -------------------------------------------------------------------------------------------------
// Durable saga + compensation state machine

export type SagaState = "running" | "compensating" | "completed" | "compensated" | "manual-review"
export type SagaStepState =
  | "executing"
  | "committed"
  | "failed"
  | "ambiguous"
  | "compensating"
  | "compensation-failed"
  | "compensated"

export interface SagaStepRecord {
  readonly name: string
  readonly effectId: string
  readonly compensationEffectId: string
  readonly state: SagaStepState
  readonly compensationArgs: unknown
  readonly result?: unknown
  readonly attempts: number
  readonly nextAttemptAt?: number
  readonly errorCode?: string
}

export interface SagaRecord {
  readonly sagaId: string
  readonly definition: string
  readonly state: SagaState
  readonly input: unknown
  readonly steps: readonly SagaStepRecord[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
}

export interface SagaStore {
  readonly durability?: "memory" | "durable"
  create(record: SagaRecord): boolean | Promise<boolean>
  get(sagaId: string): SagaRecord | undefined | Promise<SagaRecord | undefined>
  /** Atomic version compare-and-set; this is the saga engine's crash/concurrency boundary. */
  compareAndSet(input: {
    readonly sagaId: string
    readonly version: number
    readonly record: SagaRecord
  }): boolean | Promise<boolean>
  /** Bounded operational scan. Transition-only stores do not need to implement reconciliation. */
  scan?(
    input: ReconciliationScanOptions<SagaState>,
  ): ReconciliationScanPage<SagaRecord> | Promise<ReconciliationScanPage<SagaRecord>>
  /** @deprecated Compatibility fallback; production reconciliation should implement `scan`. */
  list?(): readonly SagaRecord[] | Promise<readonly SagaRecord[]>
}

export interface SagaStepExecutionContext {
  readonly effectId: string
  readonly signal: AbortSignal
}
export interface SagaCompensationContext {
  readonly effectId: string
  readonly sagaId: string
  readonly attempt: number
  readonly signal: AbortSignal
}

export interface SagaRunContext<C extends Record<string, unknown>> {
  step<K extends keyof C & string, T>(
    name: K,
    compensationArgs: C[K],
    execute: (context: SagaStepExecutionContext) => T | PromiseLike<T>,
  ): Promise<T>
}

export interface SagaDefinition<I, C extends Record<string, unknown>> {
  readonly name: string
  readonly capability?: string
  readonly run: (context: SagaRunContext<C>, input: I) => void | PromiseLike<void>
  readonly compensators: {
    readonly [K in keyof C]: (
      args: C[K],
      context: SagaCompensationContext,
    ) => void | PromiseLike<void>
  }
  readonly retry?: {
    readonly maxAttempts?: number
    readonly backoffMs?: (attempt: number) => number
  }
}

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
    const next = Object.freeze({ ...update, version: current.version + 1 })
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
  ): Omit<SagaRecord, "version"> => ({
    ...record,
    state,
    steps: Object.freeze(
      record.steps.map((candidate, candidateIndex) =>
        candidateIndex === index ? Object.freeze(step) : candidate,
      ),
    ),
    updatedAt: now(),
  })
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
    if (
      current === undefined ||
      current.version !== input.version ||
      input.record.version !== input.version + 1
    )
      return false
    this.records.set(input.sagaId, Object.freeze(cloneValue(input.record)))
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
