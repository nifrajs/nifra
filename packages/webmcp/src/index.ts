/**
 * Nifra's typed Agent Surface contract and WebMCP adapter.
 *
 * WebMCP is the page-local transport: a compatible host discovers the standard
 * `document.modelContext.registerTool` surface. Nifra adds typed core-tool
 * execution, deterministic prediction/reconciliation, bounded receipts, and a
 * host-independent conformance runner around that transport.
 */

import { type InferOutput, type StandardSchemaV1, validateStandard } from "@nifrajs/core/schema"
import { toCatalogEntry } from "@nifrajs/core/tool-catalog"
import {
  defineTool,
  executeTool,
  type ToolApproval,
  type ToolCallOptions,
  type ToolCallResult,
  type ToolContract,
  type ToolContractOptions,
  type ToolError,
  type ToolEvidence,
} from "@nifrajs/core/tool-contract"

const MAX_ID_LENGTH = 128
const MAX_PATH_LENGTH = 256
const MAX_PATCH_OPERATIONS = 256
const MAX_ACTIVE_PREDICTIONS = 256
const MAX_PATCH_VALUE_BYTES = 64 * 1024
const DEFAULT_MAX_RECEIPT_BYTES = 16 * 1024
const MAX_RECEIPT_BYTES = 64 * 1024
const MAX_REGISTRATION_ERROR_LENGTH = 256
const VERSION_RE = /^[-A-Za-z0-9._:/]{1,128}$/
const STATE_PATH_RE = /^[a-z][A-Za-z0-9._:/-]{0,127}$/
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"])

export type AgentSurfaceScope = "page" | "session" | "server"

export type ReconciliationMode = "accept-server-state" | "reload" | "manual"

export interface AgentSurfaceDescriptor {
  readonly scope: AgentSurfaceScope
  readonly reads: readonly string[]
  readonly writes: readonly string[]
  readonly reconciliation: ReconciliationMode
}

export interface AgentSurfaceSnapshot<State> {
  readonly state: State
  readonly version: string
}

/** The safe RFC 6902 subset accepted for speculative UI updates. */
export type PredictionPatchOperation =
  | { readonly op: "add" | "replace"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string }

export interface AgentSurfacePrediction {
  readonly baseVersion: string
  readonly patch: readonly PredictionPatchOperation[]
  readonly expiresAt?: number
}

export interface AgentSurfacePredictionContext<State, Input> {
  readonly input: Input
  readonly snapshot: State
  readonly version: string
  readonly now: number
}

export interface AgentSurfaceAuthoritativeState<State> {
  readonly state: State
  readonly version: string
}

export interface AgentSurfaceReconcileContext<Input, Output, State> {
  readonly input: Input
  readonly output: Output
  readonly previous: AgentSurfaceSnapshot<State>
  readonly prediction: AgentSurfacePrediction
  readonly now: number
}

export type AgentSurfacePredictor<Input, State> = (
  context: AgentSurfacePredictionContext<State, Input>,
) => AgentSurfacePrediction | PromiseLike<AgentSurfacePrediction>

export type AgentSurfaceReconciler<Input, Output, State> = (
  context: AgentSurfaceReconcileContext<Input, Output, State>,
) => AgentSurfaceAuthoritativeState<State> | PromiseLike<AgentSurfaceAuthoritativeState<State>>

export interface AgentCapability<Input, Output, State = unknown> {
  readonly tool: ToolContract<Input, Output>
  readonly surface: AgentSurfaceDescriptor
  readonly predict?: AgentSurfacePredictor<Input, State>
  readonly reconcile?: AgentSurfaceReconciler<Input, Output, State>
}

/**
 * The erased, read-only handle accepted by capability registries.
 *
 * A real application commonly registers tools with unrelated input and output types. Registry
 * boundaries therefore use this structural view instead of pretending the whole array has one
 * homogeneous generic type. Individual calls remain validated and typed at their capability's
 * `tool` boundary.
 */
export type AgentCapabilityReference = {
  readonly tool: Omit<
    ToolContract,
    "input" | "output" | "execute" | "idempotency" | "cost" | "policy"
  > & {
    readonly input: StandardSchemaV1
    readonly output: StandardSchemaV1
    readonly execute: (...args: never[]) => unknown | PromiseLike<unknown>
    readonly idempotency?: unknown
    readonly cost?: unknown
    readonly policy?: unknown
  }
  readonly surface: AgentSurfaceDescriptor
}

export type DefineAgentCapabilityOptions<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
  State,
> = ToolContractOptions<
  InferOutput<InputSchema>,
  InferOutput<OutputSchema>,
  InputSchema,
  OutputSchema
> & {
  readonly scope?: AgentSurfaceScope
  readonly reads?: readonly string[]
  readonly writes?: readonly string[]
  readonly reconciliation?: ReconciliationMode
  readonly predict?: AgentSurfacePredictor<InferOutput<InputSchema>, State>
  readonly reconcile?: AgentSurfaceReconciler<
    InferOutput<InputSchema>,
    InferOutput<OutputSchema>,
    State
  >
}

/** Create a capability from the same core tool contract used by Nifra's other adapters. */
export function defineAgentCapability<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
  State = unknown,
>(
  options: DefineAgentCapabilityOptions<InputSchema, OutputSchema, State>,
): AgentCapability<InferOutput<InputSchema>, InferOutput<OutputSchema>, State> {
  const tool = defineTool(options)
  const scope = options.scope ?? "page"
  if (scope !== "page" && scope !== "session" && scope !== "server")
    throw new TypeError("agent surface: scope is invalid")
  const reads = validateStatePaths(options.reads ?? [], "reads")
  const writes = validateStatePaths(options.writes ?? [], "writes")
  const reconciliation = options.reconciliation ?? "manual"
  if (
    reconciliation !== "accept-server-state" &&
    reconciliation !== "reload" &&
    reconciliation !== "manual"
  )
    throw new TypeError("agent surface: reconciliation is invalid")
  if (options.predict !== undefined && options.reconcile === undefined)
    throw new TypeError("agent surface: predict requires reconcile")
  return Object.freeze({
    tool,
    surface: Object.freeze({
      scope,
      reads: Object.freeze(reads),
      writes: Object.freeze(writes),
      reconciliation,
    }),
    ...(options.predict === undefined ? {} : { predict: options.predict }),
    ...(options.reconcile === undefined ? {} : { reconcile: options.reconcile }),
  })
}

function validateStatePaths(paths: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(paths)) throw new TypeError(`agent surface: ${label} must be an array`)
  const unique = new Set<string>()
  for (const path of paths) {
    if (typeof path !== "string" || !STATE_PATH_RE.test(path))
      throw new TypeError(`agent surface: ${label} contains an invalid path`)
    unique.add(path)
  }
  return [...unique]
}

export interface WebMcpToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations: AgentCapability<unknown, unknown>["tool"]["annotations"]
  readonly execute: (input: unknown) => unknown | PromiseLike<unknown>
}

export interface WebMcpExecutionOptions extends Omit<ToolCallOptions, "signal" | "capabilities"> {
  /** Extra capability tokens may be supplied by an embedding host; the tool's own token is always added. */
  readonly capabilities?: readonly string[]
  /** A page-local authorization check. Server authorization remains mandatory for remote writes. */
  readonly authorize?: (input: unknown) => boolean | PromiseLike<boolean>
  /** Return the Nifra receipt envelope (default) or only the typed output on success. */
  readonly resultMode?: "receipt" | "output"
  /** Maximum JSON-encoded output bytes retained in the default receipt. */
  readonly maxReceiptBytes?: number
}

export interface WebMcpReceipt<Output = unknown> {
  readonly ok: boolean
  readonly outcome: "committed" | "dry-run" | "failed" | "denied"
  readonly dryRun: boolean
  readonly output?: Output
  readonly outputTruncated?: true
  readonly error?: { readonly code: ToolError["code"]; readonly stage: ToolError["stage"] }
  readonly evidence: readonly ToolEvidence[]
}

/** Adapt one canonical capability to the proposed WebMCP tool shape. */
export function toWebMcpTool<Input, Output, State>(
  capability: AgentCapability<Input, Output, State>,
  options: WebMcpExecutionOptions = {},
): WebMcpToolDefinition {
  const maxReceiptBytes = validateReceiptLimit(options.maxReceiptBytes)
  const entry = toCatalogEntry(capability.tool)
  const fixedCapabilities = [capability.tool.capability, ...(options.capabilities ?? [])]
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    annotations: entry.annotations,
    execute: async (input) => {
      if (options.authorize !== undefined) {
        let authorized = false
        try {
          authorized = await options.authorize(input)
        } catch {
          // A page-local guard is untrusted adapter code. Treat a thrown guard as a denial rather
          // than leaking its exception through the WebMCP host.
          authorized = false
        }
        if (!authorized) return deniedReceipt(options.dryRun === true)
      }
      const result = await executeAgentCapability(capability, input, {
        ...options,
        capabilities: fixedCapabilities,
      })
      const receipt = toReceipt(result, maxReceiptBytes)
      // Raw output mode is explicitly opt-in and exists for hosts that already impose their own
      // response limits. The default receipt path stays bounded.
      if (options.resultMode === "output" && result.ok) return result.output
      return receipt
    },
  }
}

function deniedReceipt(dryRun: boolean): WebMcpReceipt {
  return Object.freeze({
    ok: false,
    outcome: "denied",
    dryRun,
    error: { code: "capability_denied" as const, stage: "capability" as const },
    evidence: Object.freeze([]),
  })
}

/** Execute through Nifra's existing validation, policy, approval, idempotency, and evidence path. */
export function executeAgentCapability<Input, Output, State>(
  capability: AgentCapability<Input, Output, State>,
  input: unknown,
  options: ToolCallOptions = {},
): Promise<ToolCallResult<Output>> {
  return executeTool(capability.tool, input, {
    ...options,
    capabilities: [capability.tool.capability, ...(options.capabilities ?? [])],
  })
}

function toReceipt<Output>(
  result: ToolCallResult<Output>,
  maxReceiptBytes: number,
): WebMcpReceipt<Output> {
  if (result.ok) {
    const bounded = boundReceiptOutput(result.output, maxReceiptBytes)
    return Object.freeze({
      ok: true,
      outcome: result.dryRun ? "dry-run" : "committed",
      dryRun: result.dryRun,
      ...(bounded.output === undefined ? {} : { output: bounded.output }),
      ...(bounded.truncated ? { outputTruncated: true as const } : {}),
      evidence: result.evidence,
    })
  }
  return Object.freeze({
    ok: false,
    outcome: "failed",
    dryRun: result.dryRun,
    error: { code: result.error.code, stage: result.error.stage },
    evidence: result.evidence,
  })
}

function validateReceiptLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RECEIPT_BYTES
  if (!Number.isSafeInteger(value) || value < 256 || value > MAX_RECEIPT_BYTES)
    throw new RangeError(
      `agent surface: maxReceiptBytes must be a safe integer between 256 and ${MAX_RECEIPT_BYTES}`,
    )
  return value
}

function boundReceiptOutput<Output>(
  output: Output | undefined,
  maxBytes: number,
): { readonly output?: Output; readonly truncated?: true } {
  if (output === undefined) return {}
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(output))
    return encoded.byteLength <= maxBytes ? { output } : { truncated: true }
  } catch {
    // A non-JSON output is not safe to put in a portable receipt. The typed output mode remains
    // available to an embedding host that has its own serialization contract.
    return { truncated: true }
  }
}

export interface WebMcpModelContext {
  readonly registerTool: (tool: WebMcpToolDefinition) => void | PromiseLike<void>
  readonly unregisterTool?: (name: string) => void | PromiseLike<void>
}

export interface WebMcpTarget {
  readonly modelContext?: WebMcpModelContext
}

export interface WebMcpRegistrationFailure {
  readonly name: string
  readonly error: string
}

export interface WebMcpRegistrationReport {
  readonly supported: boolean
  readonly registered: readonly string[]
  readonly failed: readonly WebMcpRegistrationFailure[]
  readonly cleanup: () => Promise<void>
}

const targetRegistrations = new WeakMap<object, Set<string>>()

function defaultTarget(): WebMcpTarget | undefined {
  const page = (globalThis as typeof globalThis & { readonly document?: WebMcpTarget }).document
  return page
}

/** Register an explicit allowlist of capabilities, safely degrading on ordinary browsers. */
export async function registerWebMcpTools(
  capabilities: readonly AgentCapabilityReference[],
  target: WebMcpTarget | undefined = defaultTarget(),
  options: WebMcpExecutionOptions = {},
): Promise<WebMcpRegistrationReport> {
  const context = target?.modelContext
  if (context === undefined || typeof context.registerTool !== "function")
    return Object.freeze({
      supported: false,
      registered: Object.freeze([]),
      failed: Object.freeze([]),
      cleanup: async () => {},
    })

  const key = context as object
  const existing = targetRegistrations.get(key) ?? new Set<string>()
  targetRegistrations.set(key, existing)
  const registered: string[] = []
  const failed: WebMcpRegistrationFailure[] = []
  for (const capability of capabilities) {
    const name = capability.tool.name
    if (existing.has(name)) {
      failed.push({ name, error: "duplicate tool name is already registered" })
      continue
    }
    // Reserve before awaiting the host. `registerTool` may be asynchronous, and another caller can
    // enter this function while it is pending. Keeping the reservation in the same set as committed
    // names makes duplicate detection atomic from JavaScript's point of view; failures release only
    // their own reservation so a later registration can retry safely.
    existing.add(name)
    try {
      await context.registerTool(
        toWebMcpTool(capability as unknown as AgentCapability<unknown, unknown, unknown>, options),
      )
      registered.push(name)
    } catch (error) {
      existing.delete(name)
      if (existing.size === 0 && targetRegistrations.get(key) === existing)
        targetRegistrations.delete(key)
      failed.push({ name, error: describeError(error) })
    }
  }
  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    if (context.unregisterTool === undefined) return
    for (const name of [...registered].reverse()) {
      try {
        await context.unregisterTool(name)
        existing.delete(name)
      } catch {
        // Cleanup is best effort; a host failure must not break the application.
      }
    }
    if (existing.size === 0 && targetRegistrations.get(key) === existing)
      targetRegistrations.delete(key)
  }
  return Object.freeze({
    supported: true,
    registered: Object.freeze([...registered]),
    failed: Object.freeze([...failed]),
    cleanup,
  })
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= MAX_REGISTRATION_ERROR_LENGTH
    ? message
    : `${message.slice(0, MAX_REGISTRATION_ERROR_LENGTH - 3)}...`
}

export interface PredictionStoreSnapshot<State> extends AgentSurfaceSnapshot<State> {
  readonly authoritativeVersion: string
  readonly activePredictionIds: readonly string[]
}

export type PredictionStoreEvent<State> =
  | {
      readonly type: "predicted"
      readonly predictionId: string
      readonly snapshot: PredictionStoreSnapshot<State>
    }
  | {
      readonly type: "committed"
      readonly predictionId: string
      readonly snapshot: PredictionStoreSnapshot<State>
    }
  | {
      readonly type: "rolled-back"
      readonly predictionId: string
      readonly snapshot: PredictionStoreSnapshot<State>
    }
  | {
      readonly type: "conflicted"
      readonly predictionId: string
      readonly snapshot: PredictionStoreSnapshot<State>
    }
  | {
      readonly type: "expired"
      readonly predictionId: string
      readonly snapshot: PredictionStoreSnapshot<State>
    }

export type PredictionStoreResult<State> = {
  readonly outcome:
    | "predicted"
    | "committed"
    | "rolled-back"
    | "conflicted"
    | "expired"
    | "stale"
    | "invalid"
    | "missing"
  readonly predictionId: string
  readonly snapshot: PredictionStoreSnapshot<State>
}

export interface PredictionStore<State> {
  readonly snapshot: () => PredictionStoreSnapshot<State>
  readonly predict: (
    predictionId: string,
    prediction: AgentSurfacePrediction,
    now?: number,
  ) => PredictionStoreResult<State>
  readonly commit: (
    predictionId: string,
    authoritative: AgentSurfaceAuthoritativeState<State>,
    now?: number,
  ) => PredictionStoreResult<State>
  readonly rollback: (predictionId: string) => PredictionStoreResult<State>
  readonly expire: (now?: number) => readonly string[]
  readonly subscribe: (listener: (event: PredictionStoreEvent<State>) => void) => () => void
}

interface StoredPrediction {
  readonly id: string
  readonly prediction: AgentSurfacePrediction
}

/**
 * An atomic, defensive prediction store. Predictions are overlays over authoritative state; a server
 * commit replaces the base and remaining overlays are replayed or conflict-dropped.
 */
export function createPredictionStore<State>(
  initial: AgentSurfaceAuthoritativeState<State>,
): PredictionStore<State> {
  let authoritative = cloneValue(initial, "initial state")
  validateVersion(initial.version)
  const active = new Map<string, StoredPrediction>()
  const conflicted = new Map<string, true>()
  const order: string[] = []
  const listeners = new Set<(event: PredictionStoreEvent<State>) => void>()

  const removeActive = (id: string): void => {
    active.delete(id)
    const index = order.indexOf(id)
    if (index !== -1) order.splice(index, 1)
  }

  const rememberConflict = (id: string): void => {
    conflicted.delete(id)
    if (conflicted.size >= MAX_ACTIVE_PREDICTIONS) {
      const oldest = conflicted.keys().next().value
      if (oldest !== undefined) conflicted.delete(oldest)
    }
    conflicted.set(id, true)
  }

  const snapshot = (): PredictionStoreSnapshot<State> => {
    let state = cloneValue(authoritative.state, "authoritative state")
    const invalid: string[] = []
    for (const id of [...order]) {
      const stored = active.get(id)
      if (stored === undefined) continue
      try {
        state = applyPredictionPatch(state, stored.prediction.patch)
      } catch {
        invalid.push(id)
      }
    }
    for (const id of invalid) {
      removeActive(id)
      rememberConflict(id)
    }
    return Object.freeze({
      state,
      version: authoritative.version,
      authoritativeVersion: authoritative.version,
      activePredictionIds: Object.freeze(order.filter((id) => active.has(id))),
    })
  }

  const emit = (event: PredictionStoreEvent<State>): void => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // Observer failures cannot change the state machine.
      }
    }
  }

  const predict = (
    predictionId: string,
    prediction: AgentSurfacePrediction,
    now = Date.now(),
  ): PredictionStoreResult<State> => {
    validateIdentifier(predictionId, "prediction id")
    validatePrediction(prediction)
    const current = snapshot()
    if (active.has(predictionId) || conflicted.has(predictionId))
      return { outcome: "invalid", predictionId, snapshot: current }
    if (active.size >= MAX_ACTIVE_PREDICTIONS)
      return { outcome: "invalid", predictionId, snapshot: current }
    if (prediction.baseVersion !== authoritative.version)
      return { outcome: "stale", predictionId, snapshot: current }
    if (prediction.expiresAt !== undefined && prediction.expiresAt <= now)
      return { outcome: "expired", predictionId, snapshot: current }
    const candidate = applyPredictionPatch(current.state, prediction.patch)
    // Clone before storing so caller mutation after predict cannot change the overlay.
    const stored: StoredPrediction = {
      id: predictionId,
      prediction: Object.freeze({
        baseVersion: prediction.baseVersion,
        patch: Object.freeze(prediction.patch.map((op) => clonePatchOperation(op))),
        ...(prediction.expiresAt === undefined ? {} : { expiresAt: prediction.expiresAt }),
      }),
    }
    active.set(predictionId, stored)
    order.push(predictionId)
    const next = snapshot()
    // This should be impossible after candidate was applied; retain the guard as an atomicity check.
    if (!deepEqual(candidate, next.state)) {
      removeActive(predictionId)
      return { outcome: "invalid", predictionId, snapshot: snapshot() }
    }
    const result = { outcome: "predicted" as const, predictionId, snapshot: next }
    emit({ type: "predicted", predictionId, snapshot: next })
    return result
  }

  const discardUnreplayablePredictions = (): readonly string[] => {
    const discarded: string[] = []
    let projected = cloneValue(authoritative.state, "authoritative state")
    for (const id of [...order]) {
      const stored = active.get(id)
      if (stored === undefined) continue
      if (stored.prediction.baseVersion !== authoritative.version) {
        removeActive(id)
        rememberConflict(id)
        discarded.push(id)
        continue
      }
      try {
        projected = applyPredictionPatch(projected, stored.prediction.patch)
      } catch {
        removeActive(id)
        rememberConflict(id)
        discarded.push(id)
      }
    }
    return Object.freeze(discarded)
  }

  const commit = (
    predictionId: string,
    nextAuthoritative: AgentSurfaceAuthoritativeState<State>,
    now = Date.now(),
  ): PredictionStoreResult<State> => {
    validateIdentifier(predictionId, "prediction id")
    const stored = active.get(predictionId)
    const current = snapshot()
    if (stored === undefined) {
      if (conflicted.delete(predictionId))
        return { outcome: "conflicted", predictionId, snapshot: current }
      return { outcome: "missing", predictionId, snapshot: current }
    }
    if (stored.prediction.expiresAt !== undefined && stored.prediction.expiresAt <= now) {
      removeActive(predictionId)
      const expired = snapshot()
      emit({ type: "expired", predictionId, snapshot: expired })
      return { outcome: "expired", predictionId, snapshot: expired }
    }
    if (stored.prediction.baseVersion !== authoritative.version) {
      removeActive(predictionId)
      rememberConflict(predictionId)
      const conflicted = snapshot()
      emit({ type: "conflicted", predictionId, snapshot: conflicted })
      return { outcome: "conflicted", predictionId, snapshot: conflicted }
    }
    validateVersion(nextAuthoritative.version)
    const nextState = cloneValue(nextAuthoritative.state, "authoritative state")
    removeActive(predictionId)
    authoritative = { state: nextState, version: nextAuthoritative.version }
    const discarded = discardUnreplayablePredictions()
    const committed = snapshot()
    emit({ type: "committed", predictionId, snapshot: committed })
    for (const id of discarded) emit({ type: "conflicted", predictionId: id, snapshot: committed })
    return { outcome: "committed", predictionId, snapshot: committed }
  }

  const rollback = (predictionId: string): PredictionStoreResult<State> => {
    validateIdentifier(predictionId, "prediction id")
    if (!active.has(predictionId)) return { outcome: "missing", predictionId, snapshot: snapshot() }
    removeActive(predictionId)
    const rolledBack = snapshot()
    emit({ type: "rolled-back", predictionId, snapshot: rolledBack })
    return { outcome: "rolled-back", predictionId, snapshot: rolledBack }
  }

  const expire = (now = Date.now()): readonly string[] => {
    const expired: string[] = []
    for (const id of [...order]) {
      const stored = active.get(id)
      if (stored?.prediction.expiresAt !== undefined && stored.prediction.expiresAt <= now) {
        removeActive(id)
        expired.push(id)
        emit({ type: "expired", predictionId: id, snapshot: snapshot() })
      }
    }
    return Object.freeze(expired)
  }

  return {
    snapshot,
    predict,
    commit,
    rollback,
    expire,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export interface PredictedExecutionResult<Output, State> {
  readonly outcome:
    | "committed"
    | "rolled-back"
    | "conflicted"
    | "expired"
    | "stale"
    | "invalid"
    | "executed"
  readonly predictionId?: string
  readonly prediction?: AgentSurfacePrediction
  readonly tool?: ToolCallResult<Output>
  readonly snapshot: PredictionStoreSnapshot<State>
}

export interface ExecutePredictedOptions extends Omit<ToolCallOptions, "capabilities"> {
  readonly capabilities?: readonly string[]
  readonly predictionId?: string
  readonly now?: () => number
}

/** Apply a pure prediction, execute the core tool, then commit or roll it back atomically. */
export async function executePredicted<Input, Output, State>(
  capability: AgentCapability<Input, Output, State>,
  input: unknown,
  store: PredictionStore<State>,
  options: ExecutePredictedOptions = {},
): Promise<PredictedExecutionResult<Output, State>> {
  const now = options.now ?? Date.now
  const validated = await validateStandard(capability.tool.input, input)
  if (options.signal?.aborted) return { outcome: "rolled-back", snapshot: store.snapshot() }
  if (!validated.ok) {
    const tool = await executeAgentCapability(capability, input, options)
    return {
      outcome: "executed",
      tool,
      snapshot: store.snapshot(),
    }
  }
  if (capability.predict === undefined) {
    const tool = await executeAgentCapability(capability, input, options)
    return {
      outcome: tool.ok ? "executed" : "rolled-back",
      tool,
      snapshot: store.snapshot(),
    }
  }
  if (capability.reconcile === undefined)
    throw new TypeError("agent surface: prediction capability has no reconciler")
  const before = store.snapshot()
  const predictionInput = cloneValue(validated.value, "prediction input")
  const prediction = await capability.predict({
    input: predictionInput,
    snapshot: before.state,
    version: before.version,
    now: now(),
  })
  if (options.signal?.aborted) return { outcome: "rolled-back", snapshot: store.snapshot() }
  const predictionId = options.predictionId ?? crypto.randomUUID()
  const proposed = store.predict(predictionId, prediction, now())
  if (proposed.outcome !== "predicted")
    return {
      outcome: proposed.outcome === "missing" ? "invalid" : proposed.outcome,
      predictionId,
      prediction,
      snapshot: proposed.snapshot,
    }
  const tool = await executeAgentCapability(capability, input, options)
  if (!tool.ok || options.signal?.aborted) {
    const rolledBack = store.rollback(predictionId)
    return { outcome: "rolled-back", predictionId, prediction, tool, snapshot: rolledBack.snapshot }
  }
  let authoritative: AgentSurfaceAuthoritativeState<State>
  try {
    authoritative = await capability.reconcile({
      input: cloneValue(predictionInput, "reconciliation input"),
      output: cloneValue(tool.output as Output, "reconciliation output"),
      previous: before,
      prediction,
      now: now(),
    })
  } catch {
    const rolledBack = store.rollback(predictionId)
    return { outcome: "rolled-back", predictionId, prediction, tool, snapshot: rolledBack.snapshot }
  }
  if (options.signal?.aborted) {
    const rolledBack = store.rollback(predictionId)
    return { outcome: "rolled-back", predictionId, prediction, tool, snapshot: rolledBack.snapshot }
  }
  const committed = store.commit(predictionId, authoritative, now())
  return {
    outcome:
      committed.outcome === "committed"
        ? "committed"
        : committed.outcome === "expired"
          ? "expired"
          : "conflicted",
    predictionId,
    prediction,
    tool,
    snapshot: committed.snapshot,
  }
}

export interface AgentSurfaceConformanceCase {
  readonly capability: AgentCapabilityReference
  readonly input: unknown
  readonly assert?: (result: unknown) => void | PromiseLike<void>
}

export interface AgentSurfaceConformanceOptions {
  readonly target?: WebMcpTarget
  readonly registration?: WebMcpExecutionOptions
  readonly cases?: readonly AgentSurfaceConformanceCase[]
}

export interface AgentSurfaceConformanceResult {
  readonly supported: boolean
  readonly registered: readonly string[]
  readonly failed: readonly WebMcpRegistrationFailure[]
  readonly checks: readonly string[]
}

/** Run deterministic host-independent checks over the WebMCP projection and optional calls. */
export async function runAgentSurfaceConformance(
  capabilities: readonly AgentCapabilityReference[],
  options: AgentSurfaceConformanceOptions = {},
): Promise<AgentSurfaceConformanceResult> {
  const checks: string[] = []
  const names = new Set<string>()
  for (const capability of capabilities) {
    if (names.has(capability.tool.name))
      throw new Error(`agent surface conformance: duplicate ${capability.tool.name}`)
    names.add(capability.tool.name)
    const tool = toWebMcpTool(capability as unknown as AgentCapability<unknown, unknown, unknown>)
    if (tool.name !== capability.tool.name || typeof tool.execute !== "function")
      throw new Error(`agent surface conformance: invalid descriptor ${capability.tool.name}`)
  }
  checks.push("unique standard descriptors")
  const report = await registerWebMcpTools(capabilities, options.target, options.registration)
  if (!report.supported) {
    checks.push("unsupported host degrades safely")
    return Object.freeze({
      supported: false,
      registered: report.registered,
      failed: report.failed,
      checks: Object.freeze(checks),
    })
  }
  try {
    checks.push("host registration")
    const byName = new Map(capabilities.map((capability) => [capability.tool.name, capability]))
    for (const testCase of options.cases ?? []) {
      const capability = byName.get(testCase.capability.tool.name)
      if (capability === undefined)
        throw new Error(`agent surface conformance: unknown case ${testCase.capability.tool.name}`)
      const result = await toWebMcpTool(
        capability as unknown as AgentCapability<unknown, unknown, unknown>,
        options.registration,
      ).execute(testCase.input)
      await testCase.assert?.(result)
      checks.push(`call ${capability.tool.name}`)
    }
  } finally {
    await report.cleanup()
  }
  return Object.freeze({
    supported: true,
    registered: report.registered,
    failed: report.failed,
    checks: Object.freeze(checks),
  })
}

function validateIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH)
    throw new TypeError(`agent surface: ${label} is invalid`)
}

function validateVersion(version: string): void {
  if (typeof version !== "string" || !VERSION_RE.test(version))
    throw new TypeError("agent surface: version is invalid")
}

function validatePrediction(prediction: AgentSurfacePrediction): void {
  validateVersion(prediction.baseVersion)
  if (!Array.isArray(prediction.patch) || prediction.patch.length > MAX_PATCH_OPERATIONS)
    throw new TypeError("agent surface: prediction patch is invalid")
  if (prediction.expiresAt !== undefined && !Number.isSafeInteger(prediction.expiresAt))
    throw new TypeError("agent surface: prediction expiry is invalid")
  for (const operation of prediction.patch) {
    if (operation === null || typeof operation !== "object")
      throw new TypeError("agent surface: prediction operation is invalid")
    if (operation.op !== "add" && operation.op !== "replace" && operation.op !== "remove")
      throw new TypeError("agent surface: prediction operation is unsupported")
    if (typeof operation.path !== "string" || operation.path.length > MAX_PATH_LENGTH)
      throw new TypeError("agent surface: prediction path is invalid")
    decodePointer(operation.path)
  }
}

function cloneValue<T>(value: T, label: string): T {
  try {
    return structuredClone(value)
  } catch {
    throw new TypeError(`agent surface: ${label} must be structured-cloneable`)
  }
}

function clonePatchOperation(operation: PredictionPatchOperation): PredictionPatchOperation {
  if (operation.op === "remove") return { op: "remove", path: operation.path }
  return {
    op: operation.op,
    path: operation.path,
    value: clonePatchValue(operation.value),
  }
}

function clonePatchValue<T>(value: T): T {
  try {
    const cloned = structuredClone(value)
    const encoded = JSON.stringify(cloned)
    if (encoded === undefined)
      throw new TypeError("agent surface: patch value must be JSON-serializable")
    if (new TextEncoder().encode(encoded).byteLength > MAX_PATCH_VALUE_BYTES)
      throw new RangeError("agent surface: patch value exceeds its size limit")
    return cloned
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) throw error
    throw new TypeError("agent surface: patch value must be structured-cloneable JSON")
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function decodePointer(path: string): readonly string[] {
  if (path === "") return Object.freeze([])
  if (!path.startsWith("/")) throw new TypeError("agent surface: patch path must be a JSON Pointer")
  const segments = path
    .slice(1)
    .split("/")
    .map((segment) => {
      for (let index = 0; index < segment.length; index += 1) {
        if (segment[index] === "~" && segment[index + 1] !== "0" && segment[index + 1] !== "1")
          throw new TypeError("agent surface: patch pointer escape is invalid")
      }
      return segment.replace(/~1/g, "/").replace(/~0/g, "~")
    })
  if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment)))
    throw new TypeError("agent surface: prototype path is forbidden")
  return Object.freeze(segments)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function applyPredictionPatch<State>(
  state: State,
  operations: readonly PredictionPatchOperation[],
): State {
  let current: unknown = cloneValue(state, "prediction state")
  for (const operation of operations) current = applyPredictionOperation(current, operation)
  return current as State
}

function applyPredictionOperation(document: unknown, operation: PredictionPatchOperation): unknown {
  const segments = decodePointer(operation.path)
  if (segments.length === 0) {
    if (operation.op === "remove") throw new TypeError("agent surface: root removal is forbidden")
    return clonePatchValue(operation.value)
  }
  const parentSegments = segments.slice(0, -1)
  const leaf = segments[segments.length - 1]!
  const parent = readPointer(document, parentSegments)
  if (Array.isArray(parent)) {
    if (operation.op === "add") {
      if (leaf === "-") parent.push(clonePatchValue(operation.value))
      else {
        const index = arrayIndex(leaf, parent.length, true)
        parent.splice(index, 0, clonePatchValue(operation.value))
      }
      return document
    }
    const index = arrayIndex(leaf, parent.length, false)
    if (operation.op === "replace") parent[index] = clonePatchValue(operation.value)
    else parent.splice(index, 1)
    return document
  }
  if (!isRecord(parent)) throw new TypeError("agent surface: patch parent is not an object")
  if (operation.op === "replace" && !Object.hasOwn(parent, leaf))
    throw new TypeError("agent surface: replace target is missing")
  if (operation.op === "remove" && !Object.hasOwn(parent, leaf))
    throw new TypeError("agent surface: remove target is missing")
  if (operation.op === "remove") delete parent[leaf]
  else parent[leaf] = clonePatchValue(operation.value)
  return document
}

function readPointer(document: unknown, segments: readonly string[]): unknown {
  let current = document
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[arrayIndex(segment, current.length, false)]
    else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment]
    else throw new TypeError("agent surface: patch parent is missing")
  }
  return current
}

function arrayIndex(segment: string, length: number, allowEnd: boolean): number {
  if (!/^(?:0|[1-9]\d*)$/.test(segment))
    throw new TypeError("agent surface: array index is invalid")
  const index = Number(segment)
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > length ||
    (!allowEnd && index === length)
  )
    throw new TypeError("agent surface: array index is out of bounds")
  return index
}

export type {
  ToolApproval,
  ToolCallOptions,
  ToolCallResult,
  ToolContract,
  ToolContractOptions,
  ToolError,
  ToolEvidence,
}
