/** Type-only records and transition contracts shared by durable execution domains. */
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
