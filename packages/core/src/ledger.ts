/**
 * Effect ledger: a per-request, append-only, ordered record of side-effect intents and outcomes.
 *
 * Every owned effect seam (a repository write, an external call, an email send) records one entry via
 * the `useCapability` beacon. The entry type is deliberately **token-only**: capability ids, phase,
 * an adapter/resource token, dimensionless cost counters, an optional keyed digest, and an error code.
 * There is no free-form payload field — request bodies, rows, and values cannot enter the ledger, so
 * redaction holds by construction rather than by filtering. The sealed ledger carries the **route
 * pattern** (`/users/:id`), never the concrete URL, so path parameters cannot leak either.
 *
 * The ledger is the substrate that audit, replay, reconciliation, and cost accounting read.
 * This module ships the primitive: the entry contract, a bounded per-request ledger with an optional
 * tamper-evident hash chain, a sink seam, an in-memory sink, and a keyed digest helper. Durable,
 * encrypted, or retention-managed sinks implement the same {@link LedgerSink} seam externally.
 */

import { validCapabilityId } from "./internal/capability-runtime.ts"

/** Lifecycle phase of one effect. `intent` precedes execution; the rest describe its outcome. */
export type EffectPhase = "intent" | "committed" | "failed" | "compensated"

const EFFECT_PHASES: ReadonlySet<string> = new Set(["intent", "committed", "failed", "compensated"])

/**
 * Dimensionless resource counters (`{ ms: 12, calls: 1, bytes: 512 }`). Counters carry *how much
 * resource* an effect consumed; mapping counters to money/pricing is deliberately out of scope here.
 */
export type EffectCost = Readonly<Record<string, number>>

/** Token-only caller metadata shared by an effect intent and outcome. */
export interface EffectMetadata {
  /** Adapter/resource token (`repo:orders`, `provider:payments`). A token — never a value or a row. */
  readonly target?: string
  /** Dimensionless counters; see {@link EffectCost}. At most {@link MAX_COST_AXES} axes. */
  readonly cost?: EffectCost
  /** Optional keyed-HMAC digest of the effect payload (see {@link computeEffectDigest}); hex, 64 chars. */
  readonly digest?: string
}

/** Caller-supplied fields for one entry. Everything else (`seq`, `at`) is assigned by the ledger. */
export interface EffectEntryInput extends EffectMetadata {
  /** Opaque execution correlation token shared by one intent and its terminal outcome. */
  readonly effectId?: string
  /** Capability token (`db.write`, `payments.charge`). Must be a valid capability id. */
  readonly capability: string
  /** Default `"intent"`. Record `committed`/`failed`/`compensated` only after the outcome is known. */
  readonly phase?: EffectPhase
  /** Outcome error as a bounded token code — never a message, never a stack. */
  readonly error?: { readonly code: string }
}

/** One recorded effect. Frozen; token-only by construction (no payload field exists). */
export interface EffectEntry {
  /** Monotonic position within the request (0-based). The replay/simulation order. */
  readonly seq: number
  /** Milliseconds from the ledger's (injectable) clock at append time. */
  readonly at: number
  readonly effectId?: string
  readonly capability: string
  readonly phase: EffectPhase
  readonly target?: string
  readonly cost?: EffectCost
  readonly digest?: string
  readonly error?: { readonly code: string }
}

/** Tamper-evidence over the route identity, declarations, and sealed entries. */
export interface EffectChain {
  /** `hashes[i]` = SHA-256(hex) over (`hashes[i-1]` + canonical entry `i`). */
  readonly hashes: readonly string[]
  /** Last entry hash, or the route-header hash for an empty ledger. Anchor/sign this externally. */
  readonly head: string
}

/** The immutable result of sealing a request's ledger. Token-only; safe to hand to any sink. */
export interface SealedEffectLedger {
  readonly method: string
  /** The registered route pattern (`/users/:id`) — never the concrete request URL. */
  readonly path: string
  readonly entries: readonly EffectEntry[]
  /** The route's declared capability tokens — the runtime-enforcement view: recorded ⊆ declared is
   * guaranteed by the beacon, and `declared` minus the recorded ids is the unused declaration set. */
  readonly declared: readonly string[]
  /** Present when the ledger was created with `chain: true`. */
  readonly chain?: EffectChain
}

/**
 * Receives each sealed ledger once per request (only when it has entries). Implementations must not
 * assume a payload: the ledger is token-only. A durable/tenant-scoped sink lives behind this seam.
 */
export type LedgerSink = (ledger: SealedEffectLedger) => void | Promise<void>

/** Thrown by `append` when the per-request entry bound is exceeded. Fails the request closed. */
export class EffectLedgerOverflowError extends Error {
  constructor(public readonly maxEntries: number) {
    super(`effect ledger overflow: more than ${maxEntries} entries in one request`)
    this.name = "EffectLedgerOverflowError"
  }
}

/** Thrown by `append` after `seal()` — e.g. an effect attempted while streaming a response body. */
export class EffectLedgerSealedError extends Error {
  constructor() {
    super("effect ledger is sealed: effects cannot be recorded after the response settles")
    this.name = "EffectLedgerSealedError"
  }
}

/** Per-request ledger. `append` is synchronous (hot-path safe); `seal` is idempotent and async. */
export interface RequestLedger {
  /** Validate, freeze, and record one entry. Throws on invalid input, overflow, or after seal. */
  append(input: EffectEntryInput): EffectEntry
  /** Entries recorded so far (frozen snapshot view). */
  entries(): readonly EffectEntry[]
  readonly size: number
  readonly sealed: boolean
  /** Finalize the ledger (computing the chain when enabled). Idempotent — always the same result. */
  seal(): Promise<SealedEffectLedger>
}

export interface CreateRequestLedgerOptions {
  /** HTTP method of the matched route. */
  readonly method: string
  /** The registered route pattern — callers must never pass the concrete request URL. */
  readonly path: string
  /** The route's declared capability tokens, surfaced verbatim on the sealed ledger. Default `[]`. */
  readonly declared?: readonly string[]
  /** Entry bound; exceeding it throws {@link EffectLedgerOverflowError}. Default {@link DEFAULT_MAX_ENTRIES}. */
  readonly maxEntries?: number
  /** Compute the tamper-evident hash chain at seal. Default false. */
  readonly chain?: boolean
  /** Injectable monotonic clock (ms) for deterministic tests. Default `performance.now`. */
  readonly clock?: () => number
}

/** Per-request entry bound. Generous for real handlers, small enough to stop a runaway loop. */
export const DEFAULT_MAX_ENTRIES = 1_000

/** Most cost axes one entry may carry. */
export const MAX_COST_AXES = 8

const TARGET_MAX_LENGTH = 128
const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/
const DIGEST_HEX = /^[0-9a-f]{64}$/

function printableToken(value: string, maxLength: number): boolean {
  if (value.length === 0 || value.length > maxLength) return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 33 || code > 126) return false
  }
  return true
}

function validateCost(cost: EffectCost): EffectCost {
  if (Object(cost) !== cost || Array.isArray(cost)) {
    throw new TypeError("effect ledger: invalid cost")
  }
  const keys = Object.keys(cost)
  if (keys.length > MAX_COST_AXES) {
    throw new TypeError(`effect ledger: more than ${MAX_COST_AXES} cost axes`)
  }
  for (const key of keys) {
    if (!validCapabilityId(key)) {
      throw new TypeError(`effect ledger: invalid cost axis ${JSON.stringify(key)}`)
    }
    const value = cost[key]
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`effect ledger: invalid cost axis ${key}`)
    }
  }
  return Object.freeze({ ...cost })
}

/** Validate, copy, and freeze token-only effect metadata before it reaches a ledger or policy hook. */
export function normalizeEffectMetadata(input: EffectMetadata): EffectMetadata {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("effect ledger: effect metadata must be an object")
  }
  if (input.target !== undefined && !printableToken(input.target, TARGET_MAX_LENGTH)) {
    throw new TypeError("effect ledger: invalid target")
  }
  if (input.digest !== undefined && !DIGEST_HEX.test(input.digest)) {
    throw new TypeError("effect ledger: invalid digest")
  }
  return Object.freeze({
    ...(input.target !== undefined ? { target: input.target } : {}),
    ...(input.cost !== undefined ? { cost: validateCost(input.cost) } : {}),
    ...(input.digest !== undefined ? { digest: input.digest } : {}),
  })
}

const defaultClock = (): number => performance.now()

class BoundedRequestLedger implements RequestLedger {
  private readonly items: EffectEntry[] = []
  private readonly method: string
  private readonly path: string
  private readonly declared: readonly string[]
  private readonly maxEntries: number
  private readonly chain: boolean
  private readonly clock: () => number
  private sealResult: Promise<SealedEffectLedger> | undefined

  constructor(options: CreateRequestLedgerOptions) {
    if (!printableToken(options.method, 16) || !options.path.startsWith("/")) {
      throw new TypeError("effect ledger: method/path must be a route pattern")
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("effect ledger: maxEntries must be a positive safe integer")
    }
    const declared = options.declared ?? []
    for (const id of declared) {
      if (!validCapabilityId(id)) {
        throw new TypeError(`effect ledger: invalid declared capability ${JSON.stringify(id)}`)
      }
    }
    this.method = options.method.toUpperCase()
    this.path = options.path
    this.declared = Object.freeze([...declared])
    this.maxEntries = maxEntries
    this.chain = options.chain ?? false
    this.clock = options.clock ?? defaultClock
  }

  get size(): number {
    return this.items.length
  }

  get sealed(): boolean {
    return this.sealResult !== undefined
  }

  append(input: EffectEntryInput): EffectEntry {
    if (this.sealResult !== undefined) throw new EffectLedgerSealedError()
    if (this.items.length >= this.maxEntries) throw new EffectLedgerOverflowError(this.maxEntries)
    if (!validCapabilityId(input.capability)) {
      throw new TypeError(`effect ledger: invalid capability ${JSON.stringify(input.capability)}`)
    }
    const phase = input.phase ?? "intent"
    if (!EFFECT_PHASES.has(phase)) {
      throw new TypeError(`effect ledger: invalid phase ${JSON.stringify(phase)}`)
    }
    if (input.effectId !== undefined && !printableToken(input.effectId, 64)) {
      throw new TypeError("effect ledger: invalid effectId")
    }
    if (input.target !== undefined && !printableToken(input.target, TARGET_MAX_LENGTH)) {
      throw new TypeError("effect ledger: invalid target")
    }
    if (input.digest !== undefined && !DIGEST_HEX.test(input.digest)) {
      throw new TypeError("effect ledger: invalid digest")
    }
    if (input.error !== undefined && !ERROR_CODE.test(input.error.code)) {
      throw new TypeError("effect ledger: error code must be a bounded lowercase token")
    }
    // Only the known token fields are copied — a stray `payload`-like property never survives append.
    const at = this.clock()
    if (!Number.isFinite(at) || at < 0) {
      throw new TypeError("effect ledger: clock must return a finite non-negative number")
    }
    const entry: EffectEntry = Object.freeze({
      seq: this.items.length,
      at,
      ...(input.effectId !== undefined ? { effectId: input.effectId } : {}),
      capability: input.capability,
      phase,
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.cost !== undefined ? { cost: validateCost(input.cost) } : {}),
      ...(input.digest !== undefined ? { digest: input.digest } : {}),
      ...(input.error !== undefined ? { error: Object.freeze({ code: input.error.code }) } : {}),
    })
    this.items.push(entry)
    return entry
  }

  entries(): readonly EffectEntry[] {
    return Object.freeze([...this.items])
  }

  seal(): Promise<SealedEffectLedger> {
    this.sealResult ??= this.sealOnce()
    return this.sealResult
  }

  private async sealOnce(): Promise<SealedEffectLedger> {
    const entries = Object.freeze([...this.items])
    const base = {
      method: this.method,
      path: this.path,
      entries,
      declared: this.declared,
    }
    if (!this.chain) return Object.freeze(base)
    const hashes: string[] = []
    // Seed the chain with the route identity and declared authority. Otherwise an anchored entry
    // chain could be copied onto a different route/declaration without changing its head.
    let previous = await sha256Hex(
      JSON.stringify({ method: this.method, path: this.path, declared: [...this.declared].sort() }),
    )
    for (const entry of entries) {
      previous = await sha256Hex(`${previous}${canonicalEntry(entry)}`)
      hashes.push(previous)
    }
    return Object.freeze({
      ...base,
      chain: Object.freeze({ hashes: Object.freeze(hashes), head: previous }),
    })
  }
}

/** Create a bounded per-request ledger. The server wires one per capability-declaring route. */
export function createRequestLedger(options: CreateRequestLedgerOptions): RequestLedger {
  return new BoundedRequestLedger(options)
}

/** Canonical, key-ordered serialization of one entry — the hash-chain input. */
function canonicalEntry(entry: EffectEntry): string {
  const cost =
    entry.cost === undefined
      ? ""
      : `,"cost":{${Object.keys(entry.cost)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${JSON.stringify((entry.cost as EffectCost)[key])}`)
          .join(",")}}`
  return (
    `{"seq":${entry.seq},"at":${JSON.stringify(entry.at)}` +
    `${entry.effectId !== undefined ? `,"effectId":${JSON.stringify(entry.effectId)}` : ""}` +
    `,"capability":${JSON.stringify(entry.capability)},"phase":${JSON.stringify(entry.phase)}` +
    `${entry.target !== undefined ? `,"target":${JSON.stringify(entry.target)}` : ""}` +
    cost +
    `${entry.digest !== undefined ? `,"digest":${JSON.stringify(entry.digest)}` : ""}` +
    `${entry.error !== undefined ? `,"error":${JSON.stringify(entry.error.code)}` : ""}}`
  )
}

const encoder = new TextEncoder()

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))
  let hex = ""
  for (let index = 0; index < digest.length; index++) {
    hex += (digest[index] as number).toString(16).padStart(2, "0")
  }
  return hex
}

export interface MemoryLedgerSinkOptions {
  /** Retain at most this many sealed ledgers (oldest evicted first). Default 1000. */
  readonly maxLedgers?: number
}

export interface MemoryLedgerSink {
  readonly sink: LedgerSink
  /** Sealed ledgers received so far, oldest first. */
  readonly ledgers: readonly SealedEffectLedger[]
  clear(): void
}

/** Bounded in-memory sink for tests and local development. Token-only, like every sink. */
export function createMemoryLedgerSink(options: MemoryLedgerSinkOptions = {}): MemoryLedgerSink {
  const maxLedgers = options.maxLedgers ?? 1_000
  if (!Number.isSafeInteger(maxLedgers) || maxLedgers < 1) {
    throw new TypeError("effect ledger: maxLedgers must be a positive safe integer")
  }
  const ledgers: SealedEffectLedger[] = []
  return {
    sink: (ledger) => {
      ledgers.push(ledger)
      if (ledgers.length > maxLedgers) ledgers.shift()
    },
    get ledgers(): readonly SealedEffectLedger[] {
      return Object.freeze([...ledgers])
    },
    clear: () => {
      ledgers.length = 0
    },
  }
}

/** Minimum digest key material. A short key would make the keyed digest brute-forceable. */
export const MIN_DIGEST_KEY_BYTES = 16

/** Fresh random digest key (32 bytes). Per-process by default — persist one externally to correlate across restarts. */
export function randomEffectDigestKey(): Uint8Array {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytes
}

/**
 * Keyed HMAC-SHA-256 digest (hex) of an effect payload, for replay/reconciliation matching without
 * storing the payload. Keyed on purpose: a bare hash of low-entropy data (an email, a flag) is
 * brute-forceable and would itself leak. Digest the **whole** effect payload, never a single field.
 */
export async function computeEffectDigest(
  key: Uint8Array | CryptoKey,
  payload: Uint8Array,
): Promise<string> {
  let cryptoKey: CryptoKey
  if (key instanceof Uint8Array) {
    if (key.byteLength < MIN_DIGEST_KEY_BYTES) {
      throw new TypeError(
        `effect ledger: digest key must be at least ${MIN_DIGEST_KEY_BYTES} bytes`,
      )
    }
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      key as unknown as ArrayBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
  } else {
    const algorithm = key.algorithm as unknown as {
      readonly name?: unknown
      readonly hash?: { readonly name?: unknown }
      readonly length?: unknown
    }
    if (
      algorithm.name !== "HMAC" ||
      algorithm.hash?.name !== "SHA-256" ||
      typeof algorithm.length !== "number" ||
      algorithm.length < MIN_DIGEST_KEY_BYTES * 8 ||
      !key.usages.includes("sign")
    ) {
      throw new TypeError(
        "effect ledger: CryptoKey must be an HMAC-SHA-256 signing key of at least 128 bits",
      )
    }
    cryptoKey = key
  }
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, payload as unknown as ArrayBuffer),
  )
  let hex = ""
  for (let index = 0; index < mac.length; index++) {
    hex += (mac[index] as number).toString(16).padStart(2, "0")
  }
  return hex
}

const EFFECT_LEDGER = Symbol("nifra.effect.ledger")

/** Framework wiring: attach a per-request ledger to a handler context. Not for application code. */
export function attachEffectLedger(context: object, ledger: RequestLedger): void {
  ;(context as Record<PropertyKey, unknown>)[EFFECT_LEDGER as unknown as string] = ledger
}

/** The request's effect ledger, when the server enabled one for this route. Read-only access. */
export function effectLedgerOf(context: object): RequestLedger | undefined {
  return (context as { readonly [EFFECT_LEDGER]?: RequestLedger })[EFFECT_LEDGER]
}

/** Server-level effect ledger configuration (see `server({ effectLedger })`). */
export interface EffectLedgerOptions {
  /** Receives each request's sealed ledger (only when it recorded entries). */
  readonly sink: LedgerSink
  /** Per-request entry bound. Default {@link DEFAULT_MAX_ENTRIES}. */
  readonly maxEntries?: number
  /** Compute the tamper-evident hash chain at seal. Default false. */
  readonly chain?: boolean
}
